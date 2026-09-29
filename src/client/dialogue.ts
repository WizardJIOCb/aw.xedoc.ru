import type { Entity, Player } from "../shared/types";

type Options = {
  player: () => Player | undefined;
  itemName: (id: string) => string;
  talk: (entity: Entity) => void;
  service: (name: string) => void;
  opened: () => void;
  closed: () => void;
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** Dialogue prose is authored for this reconstruction; quest transactions remain server-owned. */
export class NpcDialogue {
  readonly element = document.createElement("dialog");
  private entity?: Entity;
  private state = "";
  private page = "greeting";
  private pending = false;
  private feedback = "";
  constructor(private options: Options) {
    this.element.className = "npc-dialogue";
    this.element.setAttribute("aria-label", "Разговор с жителем колонии");
    document.body.append(this.element);
    this.element.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.close();
    });
    this.element.addEventListener("keydown", (e) => e.stopPropagation());
    this.element.addEventListener("click", (e) => {
      if (e.target === this.element) this.close();
    });
  }
  get isOpen() {
    return this.element.open;
  }
  open(entity: Entity) {
    this.close();
    this.options.opened();
    this.entity = entity;
    this.page = "greeting";
    this.pending = false;
    this.feedback = "";
    this.state = "";
    this.refresh();
    if (!this.element.open) this.element.showModal();
    this.element.querySelector<HTMLButtonElement>(".dialogue-choice")?.focus();
  }
  close() {
    if (!this.element.open) return;
    this.element.close();
    this.entity = undefined;
    this.options.closed();
  }
  notice(text: string, kind: string) {
    if (!this.isOpen) return false;
    if (this.pending || /^(Боб|Банк|Торговец):/.test(text)) {
      this.pending = false;
      this.feedback = text.replace(/^(Боб|Банк|Торговец):\s*/, "");
      if (kind === "error") this.page = "greeting";
      this.state = "";
      this.refresh();
      return true;
    }
    return false;
  }
  refresh() {
    const npc = this.entity,
      p = this.options.player();
    if (!npc || !p) return;
    const state = JSON.stringify([
      p.quest.bobStarted,
      p.quest.bobComplete,
      p.inventory,
      p.credits,
      this.page,
      this.pending,
      this.feedback,
    ]);
    if (this.state === state) return;
    this.state = state;
    const bob = /bob|боб/i.test(npc.id + npc.name),
      bank = /bank|банк/i.test(npc.id + npc.name),
      trader = /trader|shop|торгов/i.test(npc.id + npc.name);
    const ore = Object.entries(p.inventory)
      .filter(([id]) => /ore|руда/i.test(id + this.options.itemName(id)))
      .reduce((sum, [, n]) => sum + n, 0);
    let line = bank
      ? "Здесь можно оставить находки перед дальней дорогой. Пока вещи в хранилище, они в безопасности."
      : trader
        ? "Посмотрим, что ты принёс из пустоши. У меня есть припасы и материалы для мастерских."
        : "Осваиваешься в колонии? За дорогой начинается пустошь. Сначала подготовь снаряжение.";
    if (bob)
      line = p.quest.bobComplete
        ? "Хорошая работа. Теперь у тебя есть первые материалы и немного опыта. Загляни к печи и кузнечному прессу — ремесло здесь кормит не хуже вылазок."
        : !p.quest.bobStarted
          ? "Новое лицо в Фармуне… Подойди, колонист. Мастерским нужна руда, а тебе пригодится первая работа. Возьмёшься помочь?"
          : ore >= 5
            ? "Вижу, экспедиция удалась. Передай пять единиц руды — мастерские ждут. Как и договаривались, награда твоя."
            : "Руда нужна мастерским. Начни с оловянной: её можно добывать с первого уровня геологии. Принеси пять единиц в сумке. Кирку прихватил?";
    if (this.page === "directions")
      line =
        "Оловянные месторождения есть у координат −192 : −207 и −194 : −202. Подготовь кирку, подойди к руде и щёлкни по ней. Для олова достаточно первого уровня геологии. По дороге могут встретиться опасные существа. После пяти находок возвращайся ко мне.";
    const choices: {
      label: string;
      action: () => void;
      primary?: boolean;
      disabled?: boolean;
    }[] = [];
    if (bob && !p.quest.bobComplete)
      choices.push({
        label: !p.quest.bobStarted
          ? "Я помогу. Расскажи, что нужно."
          : ore >= 5
            ? "Передать 5 единиц руды и получить награду"
            : "Напомни, что нужно принести.",
        primary: true,
        action: () => {
          this.pending = true;
          this.feedback = "";
          this.state = "";
          this.refresh();
          this.options.talk(npc);
        },
      });
    if (bob && !p.quest.bobComplete)
      choices.push({
        label: "Где искать руду?",
        action: () => {
          this.page = "directions";
          this.feedback = "";
          this.refresh();
        },
      });
    if (bank || trader)
      choices.push({
        label: bank ? "Открыть моё хранилище" : "Покажи товары и цены",
        primary: true,
        action: () => {
          this.close();
          this.options.service(bank ? "bank" : "shop");
        },
      });
    choices.push({
      label: bob && p.quest.bobStarted ? "Вернусь с находками." : "До встречи.",
      action: () => this.close(),
    });
    this.element.innerHTML = `<div class="dialogue-shell"><div class="dialogue-portrait ${bob ? "portrait-bob" : "portrait-colony"}" ${bob ? `style="background-image:url('/assets/portraits/bob.png?v=${__ASSET_VERSION__}')"` : ""}><div class="portrait-caption"><span>КОЛОНИЯ / ФАРМУН</span><strong>${bob ? "БОБ" : bank ? "ХРАНИТЕЛЬ" : "ЖИТЕЛЬ"}</strong></div></div><section class="dialogue-body"><header><div><span class="dialogue-eyebrow">${bob ? "ОТШЕЛЬНИК · ПЕРВЫЕ ШАГИ" : bank ? "БАНК КОЛОНИИ" : trader ? "ТОРГОВЕЦ КОЛОНИИ" : "РАЗГОВОР"}</span><h2>${esc(npc.name)}</h2></div><button class="dialogue-close" aria-label="Закрыть разговор">✕</button></header><div class="dialogue-line" aria-live="polite"><span class="quote-mark">“</span><p>${esc(this.feedback || line)}</p></div>${bob && !p.quest.bobComplete ? `<section class="dialogue-quest"><div><span class="dialogue-eyebrow">ПОМОЩЬ КОЛОНИИ</span><strong>Руда для мастерских</strong><p>Любая руда в сумке <b>${Math.min(ore, 5)} / 5</b></p><div class="quest-progress"><i style="width:${Math.min(100, ore * 20)}%"></i></div></div><aside><span>НАГРАДА</span><strong>75 <small>кредитов</small></strong><span>+60 опыта геологии</span></aside></section>` : ""}<div class="dialogue-choices">${choices.map((choice, i) => `<button class="dialogue-choice ${choice.primary ? "primary-choice" : ""}" data-choice="${i}" ${this.pending ? "disabled" : ""}><span>${this.pending && choice.primary ? "Ждём ответа…" : esc(choice.label)}</span><b>${choice.primary ? "↗" : "→"}</b></button>`).join("")}</div><footer><span>ESC — закончить разговор</span><span>ВЫБЕРИ ОТВЕТ</span></footer></section></div>`;
    this.element.querySelector<HTMLButtonElement>(".dialogue-close")!.onclick =
      () => this.close();
    this.element
      .querySelectorAll<HTMLButtonElement>("[data-choice]")
      .forEach((button) => {
        button.onclick = choices[Number(button.dataset.choice)].action;
      });
  }
}
