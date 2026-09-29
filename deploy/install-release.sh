#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

die() { printf 'Deployment refused: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run this installer as root.'
[[ $# -eq 2 ]] || die 'Usage: install-release.sh /var/www/aw.xedoc.ru/releases/<full-commit> <full-commit>'
commit=$2
[[ $commit =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || die 'SOURCE_COMMIT must be a full lowercase Git commit ID.'
for command in realpath node npm nginx systemctl curl python3 flock ss runuser useradd; do
    command -v "$command" >/dev/null || die "Missing prerequisite: $command"
done
root_dir=/var/www/aw.xedoc.ru
releases_dir=$root_dir/releases
current=$root_dir/current
state_dir=/var/lib/aw-xedoc
unit=/etc/systemd/system/aw-xedoc.service
site=/etc/nginx/sites-available/aw.xedoc.ru.conf
enabled_site=/etc/nginx/sites-enabled/aw.xedoc.ru.conf
release=$(realpath -e -- "$1")
[[ $release == "$releases_dir/$commit" ]] || die 'Release must resolve exactly inside releases/<SOURCE_COMMIT>; symlink escapes are rejected.'
[[ $(realpath -e -- "$releases_dir") == "$releases_dir" ]] || die 'The releases directory must not resolve outside the designated root.'
[[ ! -e $current || -L $current ]] || die 'current exists as a real file/directory; refusing to replace it.'
for path in package.json package-lock.json server/index.ts data/world.json deploy/aw-xedoc.service deploy/nginx.conf; do
    [[ -f $release/$path ]] || die "Missing release file: $path"
    [[ $(realpath -e -- "$release/$path") == "$release/"* ]] || die "Release file escapes its directory: $path"
done
if [[ -d $release/.git ]]; then
    [[ $(git -C "$release" rev-parse HEAD) == "$commit" ]] || die 'Checkout HEAD does not match SOURCE_COMMIT.'
fi
node_binary=$(realpath -e -- "$(command -v node)")
npm_cli=$(realpath -e -- "$(command -v npm)")
[[ $node_binary =~ ^/(usr|opt)/[A-Za-z0-9_./-]+$ ]] || die 'Node must be installed under /usr or /opt; ProtectHome blocks private nvm installations.'
[[ $npm_cli =~ ^/(usr|opt)/[A-Za-z0-9_./-]+$ ]] || die 'npm must be installed under /usr or /opt.'
[[ $("$node_binary" -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] || die 'Node.js 22 or newer is required.'
nginx -t
systemctl is-active --quiet nginx || die 'Nginx must already be running.'
install -d -m 0755 "$root_dir" "$releases_dir"
exec 9>/run/lock/aw-xedoc-deploy.lock
flock -n 9 || die 'Another AW deployment is running.'

# A process outside our systemd cgroup must never be displaced from the port.
listeners=$(ss -H -ltnp 'sport = :3188')
if [[ -n $listeners ]]; then
    pids=$(printf '%s\n' "$listeners" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
    [[ -n $pids ]] || die 'Port 3188 is occupied by an unidentified process.'
    for pid in $pids; do
        grep -Fq '/system.slice/aw-xedoc.service' "/proc/$pid/cgroup" || die "Port 3188 belongs to another service (PID $pid)."
    done
fi

previous=$(readlink -e -- "$current" || true)
if [[ -n $previous ]]; then
    [[ $previous == "$releases_dir/"* ]] || die 'The previous release resolves outside the AW releases directory.'
fi
[[ $previous != "$release" ]] || die 'This release is already current; use a new commit rather than mutate the running checkout.'
[[ ! -L $state_dir ]] || die 'State directory must not be a symlink.'
[[ ! -L $state_dir/state.json ]] || die 'State JSON must not be a symlink.'
if [[ -e $state_dir ]]; then
    [[ $(realpath -e -- "$state_dir") == "$state_dir" ]] || die 'State directory resolves outside /var/lib/aw-xedoc.'
fi
if [[ -e $site ]]; then
    [[ -f $site && ! -L $site ]] || die 'Existing AW Nginx config is not a regular file.'
    grep -Fq 'Managed initial configuration for aw.xedoc.ru.' "$site" || die 'An unmanaged AW Nginx config already exists; review it before deploying.'
elif nginx -T 2>/dev/null | grep -E 'server_name[^;]*[[:space:]]aw\.xedoc\.ru([[:space:];])' >/dev/null; then
    die 'Another enabled Nginx file already serves aw.xedoc.ru; preserving it for manual review.'
fi
if [[ -e $enabled_site || -L $enabled_site ]]; then
    [[ -L $enabled_site && $(readlink -m -- "$enabled_site") == "$site" ]] || die 'The AW enabled-site path is managed by another configuration.'
fi

if ! id aw-game >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin aw-game
fi
[[ $(id -u aw-game) -ne 0 ]] || die 'aw-game must not have UID 0.'
install -d -o aw-game -g aw-game -m 0750 "$state_dir"
install -d -o aw-game -g aw-game -m 0750 /var/cache/aw-xedoc/npm
runtime_path="$(dirname "$node_binary"):/usr/local/bin:/usr/bin:/bin"
# Dependency lifecycle/build commands run as the unprivileged game user.
chown -R --no-dereference aw-game:aw-game "$release"
runuser -u aw-game -- env "PATH=$runtime_path" NPM_CONFIG_CACHE=/var/cache/aw-xedoc/npm NODE_ENV=development \
    "$node_binary" "$npm_cli" --prefix "$release" ci --include=dev
runuser -u aw-game -- env "PATH=$runtime_path" NODE_ENV=development \
    "$node_binary" "$npm_cli" --prefix "$release" test
runuser -u aw-game -- env "PATH=$runtime_path" NODE_ENV=development "SOURCE_COMMIT=$commit" \
    "$node_binary" "$npm_cli" --prefix "$release" run build
[[ -f $release/dist/index.html && -f $release/node_modules/tsx/dist/cli.mjs ]] || die 'Built client or tsx runtime is missing.'
cat > "$release/release.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3188
PUBLIC_ORIGIN=https://aw.xedoc.ru
STATE_FILE=/var/lib/aw-xedoc/state.json
SOURCE_COMMIT=$commit
EOF
chmod 0644 "$release/release.env"
chown -R --no-dereference root:root "$release"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/var/backups/aw-xedoc/$stamp-$commit
install -d -m 0700 "$backup"
printf '%s\n' "$previous" > "$backup/previous-release.txt"
had_unit=0
if [[ -f $unit ]]; then cp -a -- "$unit" "$backup/aw-xedoc.service"; had_unit=1; fi
old_enabled=$(systemctl is-enabled aw-xedoc.service 2>/dev/null || true)
had_active=0
if systemctl is-active --quiet aw-xedoc.service; then had_active=1; fi
created_site=0
created_link=0
activated=0
health_file=$backup/health.json

rollback() {
    local status=${1:-$?}
    trap - ERR INT TERM EXIT
    set +e
    printf 'Release failed; restoring previous service/current link. State is retained.\n' >&2
    systemctl stop aw-xedoc.service
    if [[ -n $previous ]]; then
        ln -s -- "$previous" "$root_dir/.rollback-$$"
        mv -Tf -- "$root_dir/.rollback-$$" "$current"
    elif [[ $activated -eq 1 ]]; then rm -f -- "$current"; fi
    if [[ $had_unit -eq 1 ]]; then cp -a -- "$backup/aw-xedoc.service" "$unit"; else rm -f -- "$unit"; fi
    if [[ $created_link -eq 1 ]]; then rm -f -- "$enabled_site"; fi
    if [[ $created_site -eq 1 ]]; then rm -f -- "$site"; fi
    systemctl daemon-reload
    if [[ $had_active -eq 1 && -n $previous ]]; then systemctl restart aw-xedoc.service; fi
    if [[ $old_enabled != enabled ]]; then systemctl disable aw-xedoc.service >/dev/null 2>&1; fi
    nginx -t && systemctl reload nginx
    printf 'Backup directory: %s\n' "$backup" >&2
    exit "${status:-1}"
}
trap 'rollback "$?"' ERR
trap 'exit_status=$?; if [[ $exit_status -ne 0 ]]; then rollback "$exit_status"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $had_active -eq 1 ]]; then systemctl stop aw-xedoc.service; fi
if [[ -f $state_dir/state.json ]]; then
    cp -a -- "$state_dir/state.json" "$backup/state.json"
    chown aw-game:aw-game "$state_dir/state.json"
    chmod 0600 "$state_dir/state.json"
fi
sed "s|@NODE_BINARY@|$node_binary|g" "$release/deploy/aw-xedoc.service" > "$unit"
chmod 0644 "$unit"
if [[ ! -e $site ]]; then install -m 0644 "$release/deploy/nginx.conf" "$site"; created_site=1; fi
if [[ ! -L $enabled_site ]]; then ln -s -- "$site" "$enabled_site"; created_link=1; fi
nginx -t
ln -s -- "$release" "$root_dir/.activate-$$"
mv -Tf -- "$root_dir/.activate-$$" "$current"
activated=1
systemctl daemon-reload
systemctl enable aw-xedoc.service
systemctl restart aw-xedoc.service

healthy=0
for attempt in {1..25}; do
    if curl --noproxy '*' --fail --silent --show-error --max-time 2 http://127.0.0.1:3188/api/health > "$health_file" 2>/dev/null \
        && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") is True and d.get("sourceCommit")==sys.argv[2] else 1)' "$health_file" "$commit"; then
        healthy=1; break
    fi
    sleep 1
done
[[ $healthy -eq 1 ]] || die 'New service did not report healthy with the requested SOURCE_COMMIT.'
systemctl reload nginx
# Reload is asynchronous: the first request may still reach the previous workers.
# Give the AW virtual host a bounded 10-second window to report the exact release.
nginx_health_file=$backup/nginx-health.json
nginx_healthy=0
nginx_deadline=$(( $(date +%s%3N) + 10000 ))
while true; do
    remaining_ms=$(( nginx_deadline - $(date +%s%3N) ))
    [[ $remaining_ms -gt 0 ]] || break
    request_ms=$remaining_ms
    [[ $request_ms -le 1000 ]] || request_ms=1000
    printf -v request_timeout '%d.%03d' "$(( request_ms / 1000 ))" "$(( request_ms % 1000 ))"
    if curl --noproxy '*' --fail --silent --show-error --location --max-time "$request_timeout" \
        --resolve aw.xedoc.ru:80:127.0.0.1 --resolve aw.xedoc.ru:443:127.0.0.1 \
        http://aw.xedoc.ru/api/health > "$nginx_health_file" 2>/dev/null \
        && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") is True and d.get("sourceCommit")==sys.argv[2] else 1)' "$nginx_health_file" "$commit" 2>/dev/null; then
        nginx_healthy=1; break
    fi
    remaining_ms=$(( nginx_deadline - $(date +%s%3N) ))
    [[ $remaining_ms -gt 200 ]] || break
    sleep 0.2
done
[[ $nginx_healthy -eq 1 ]] || die 'Nginx did not report healthy with the requested SOURCE_COMMIT within 10 seconds.'
# Fetch the client only after the correct AW virtual host has passed health.
curl --noproxy '*' --fail --silent --show-error --location --max-time 10 \
    --resolve aw.xedoc.ru:80:127.0.0.1 --resolve aw.xedoc.ru:443:127.0.0.1 \
    http://aw.xedoc.ru/ >/dev/null
trap - ERR INT TERM EXIT
printf 'Installed release: %s\nState preserved: %s/state.json\nBackup: %s\n' "$commit" "$state_dir" "$backup"
printf 'DNS and public HTTPS/WebSocket/browser checks must be verified separately.\n'
