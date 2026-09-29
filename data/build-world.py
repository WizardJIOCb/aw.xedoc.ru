"""Generate the playable district catalog. Numeric balance is explicitly reconstructed."""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent
reference = {x['originalId']: x for x in json.loads((ROOT/'reference/catalog.json').read_text('utf-8'))}
items, recipes, entities = [], [], []

def item(id, name, kind='resource', original=None, skill=None, requires=None, damage=None, healing=None, description=None):
    weights = {'resource':.5,'ore':1.5,'metal':1,'food':.3,'tool':1.5,'weapon':1.6,'armor':3,'program':.01,'book':.2,'component':.1,'medicine':.2,'gem':.1,'ammo':.02,'certificate':.001}
    prices = {'resource':3,'ore':8,'metal':16,'food':12,'tool':25,'weapon':40,'armor':65,'program':20,'book':35,'component':15,'medicine':22,'gem':70,'ammo':1,'certificate':2}
    row = {'id':id,'name':name,'kind':kind,'weight':weights.get(kind,.5),'value':prices.get(kind,5),'provenance':{'name':'original' if original is not None else 'reconstruction','weight':'reconstruction','value':'reconstruction'}}
    if original is not None:
        row['originalId']=original
        row['provenance']['source']='public-webdata-2024'
    if skill: row['skill']=skill
    if requires:
        row['requires']=requires
        row['provenance']['requires']='reconstruction'
    if damage is not None:
        row['damage']=damage
        row['provenance']['damage']='reconstruction'
    if healing is not None:
        row['healing']=healing
        row['provenance']['healing']='reconstruction'
    if description: row['description']=description
    items.append(row)
    return row

def recipe(id, name, inputs, outputs, skill, level=1, station='workbench', seconds=3, original=False, requires=None):
    known_levels={'alloy_bronze','alloy_froanite','alloy_rhenite','forge_bronze_dagger','make_coke','smelt_tin','smelt_iron','smelt_gold','spin_thread','sew_shirt','sew_leather_armour','make_kevlar','bake_bread','bake_cheburek','cook_shashlik','cook_trout','cook_chicken','higrim_juice','arans','modifier_strength','modifier_geologist'}
    row={'id':id,'name':name,'inputs':inputs,'outputs':outputs,'skill':skill,'level':level,'station':station,'seconds':seconds,'provenance':{'chain':'manual-supported-adaptation' if original else 'reconstruction','quantities':'reconstruction','seconds':'reconstruction','level':'manual' if id in known_levels else 'reconstruction'}}
    if requires: row['requires']=requires
    recipes.append(row)

professions = [
 ('cooking','Кулинария','Приготовление рыбы, птицы, хлеба и сложных блюд.'),
 ('fishing','Ловля рыбы','Ловля сетью, гарпуном и ловушкой; развитие ловкости.'),
 ('herbalism','Собирательство и знахарство','Пшеница, лён, фрукты, грибы и лечебные растения.'),
 ('woodwork','Плотничество','Рубка деревьев, брёвна и палочки для стрел.'),
 ('geology','Геология','Добыча руды и кристаллов; развитие силы.'),
 ('metallurgy','Металлургия','Плавка руд в доменной печи.'),
 ('alloying','Изготовление сплавов','Сплавы нескольких руд совместно с металлургией.'),
 ('blacksmithing','Кузнечное дело','Оружие и доспехи на программируемом кузнечном прессе.'),
 ('crafting','Изготовление и обработка предметов','Стрелы, линзы, напыление и обработка материалов.'),
 ('hightech','Высокие технологии','Модификаторы из имплантатов; оригинальный порог интеллекта 40.'),
 ('tailoring','Портняжное дело','Лён, нитки, ткань, кожа и кевлар.'),
 ('lockpicking','Взлом механических замков','Закрытые ящики служебных персонажей.'),
 ('electronics','Электроника','Извлечение компонентов дроидов; оригинальный порог интеллекта 30.'),
 ('physics','Физика','Определение состава неизвестной руды анализатором спектра.'),
 ('chemistry','Химия','Сырая резина из серы и сока; оригинальный порог интеллекта 15.'),
 ('biology','Биология','Выделение ядов из скорпионов со скальпелем, шприцем и пробиркой.'),
 ('piercing','Колющее оружие','Шесты, копья и алебарды.'),
 ('fencing','Фехтование','Мечи, кинжалы и сабли.'),
 ('heavy','Тяжёлое оружие','Топоры, молоты и дубины.'),
 ('punching','Кулачный бой','Бой без оружия.'),
 ('medieval','Средневековое оружие','Луки и арбалеты.'),
 ('automatic','Автоматическое оружие','Пистолеты, автоматы и лазерное оружие.')
]

# Small tools remain buyable, as in the manual. There are no invented tool recipes.
for id,name,orig,skill in [
 ('bronze_pickaxe','Бронзовая кирка',117,'geology'),('net','Рыболовная сеть',69,'fishing'),
 ('harpoon','Гарпун',158,'fishing'),('electric_harpoon','Электрический гарпун',432,'fishing'),
 ('knife','Нож',79,'herbalism'),('sickle','Серп',80,'herbalism'),('garden_scissors','Садовые ножницы',33,'herbalism'),
 ('hammer','Молот',78,'geology'),('pickhammer','Кристальный молот',240,'geology'),
 ('crowbar','Фомка',373,'lockpicking'),('picklock','Отмычка',726,'lockpicking'),('codehacker','Взломщик кодов',727,'lockpicking'),
 ('spectralizer','Анализатор спектра',480,'physics'),('electronic_tools','Набор электронщика',461,'electronics'),
 ('scalpel','Скальпель',410,'biology'),('syringe','Шприц',606,'biology'),('test_tube','Пробирка',607,'biology'),
 ('bucket','Ведро',613,'chemistry'),('flask','Фляга',624,'herbalism'),('mug','Кружка',325,'cooking'),
 ('matches','Спички',16,'woodwork'),('arrow_mould','Форма для наконечников',290,'crafting'),('diamond_spray','Алмазный напылитель',411,'crafting'),
 ('disc_reader','Дисковод',492,'hightech'),('pitchknife','Нож для смолы',614,'herbalism'),('shovel','Лопата',467,'geology')]:
    item(id,name,'tool',orig,skill)

for id,name,orig in [('wood','Бревно',66),('planks','Доски',270),('sticks','Палочки',271),('flax','Лён',512),('thread','Нить',579),('cloth','Полотно',580),('wheat','Зерно',328),('flour','Мука',331),('water','Вода',326),('dough','Тесто',334),('forcemeat','Фарш',332),('feather','Перо',15),('raw_mushroom','Сырой гриб',174),('mushroom','Гриб',173),('cirbango','Кирбанго',9),('higrim','Хигрим',312),('deer_hide','Оленья шкура',488),('web','Паутина',540),('sulfur','Сера',473),('sand','Песок',471),('unknown_ore','Неизвестная руда',472),('saltpetre','Селитра',712),('gunpowder','Порох',714),('rubber_resin','Сок каучукового дерева',615),('raw_rubber','Сырая резина',618),('krond_leaf','Лист кронда',308),('krond_root','Корень кронда',309),('red_berries','Красные ягоды',310),('twig','Веточка сейфа',698),('rotoz_hide','Шкура ротоза',853),('fire_rotoz_hide','Шкура огненного ротоза',859)]:
    item(id,name,'resource',orig,'woodwork' if id in ['wood','planks','sticks','twig'] else 'herbalism')

ore_data=[('tin','Оловянная',131,1),('lead','Свинцовая',132,6),('copper','Медная',133,10),('iron','Железная',134,20),('silver','Серебряная',135,30),('silicon','Кремниевая',136,35),('aluminium','Алюминиевая',137,45),('gold','Золотая',138,50),('titanium','Титановая',139,60),('platinum','Платиновая',140,70),('tungsten','Вольфрамовая',141,80),('uranium','Урановая',142,90),('zirconium','Циркониевая',498,70),('hafnium','Гафниевая',499,80),('tantalum','Танталовая',500,80),('beryllium','Бериллиевая',501,80),('indium','Индиевая',502,85),('rhenium','Рениевая',503,90)]
for id,name,orig,lvl in ore_data:
    row=item(id+'_ore',name+' руда','ore',orig,'geology',{'geology':lvl})
    row['provenance']['requires']='public-description' if orig<=142 else 'reconstruction'
item('coal','Уголь','ore',167,'geology',{'geology':25})
item('coke','Кокс','metal',168,'metallurgy',{'metallurgy':25})
item('elerium','Элериум','ore',143,'geology',{'geology':100})

metal_data=[('tin','Олово',163,1),('lead','Свинец',164,6),('iron','Железо',179,20),('silver','Серебро',176,30),('gold','Золото',177,50),('titanium','Титан',181,60),('platinum','Платина',178,70)]
for id,name,orig,lvl in metal_data:
    item(id+'_bar',name+' — слиток','metal',orig)
    inputs={id+'_ore':2}
    if id in ['iron','titanium','platinum']:inputs['coke']=1
    recipe('smelt_'+id,'Выплавить '+name.lower(),inputs,{id+'_bar':1},'metallurgy',lvl,'furnace',5,original=id in ['tin','iron','gold'])
recipe('make_coke','Получить кокс',{'coal':2},{'coke':1},'metallurgy',25,'furnace',4,True)
for id,name,orig in [('bronze','Бронза',165),('bronzal','Бронзалий',180),('froanite','Фроанит',303),('dianite','Дианит',304),('zartite','Зартит',507),('haftite','Гафтит',508),('rhenite','Ренит',509),('thrilium','Трилий',851),('plastic','Пластик',305),('kevlar','Кевлар',306),('aerogel','Аэрогель',307),('glass','Стекло',710),('polymer','Полимер',708),('polygel','Полигель',709)]:
    item(id+'_bar',name+' — слиток','metal',orig)
recipe('alloy_bronze','Сплавить бронзу',{'copper_ore':1,'tin_ore':1},{'bronze_bar':1},'alloying',1,'furnace',5,True,{'metallurgy':10})
recipe('alloy_bronzal','Сплавить бронзалий',{'bronze_bar':2,'aluminium_ore':1},{'bronzal_bar':1},'alloying',30,'furnace',5)
recipe('alloy_froanite','Сплавить фроанит',{'tungsten_ore':2,'titanium_ore':1,'coke':1},{'froanite_bar':1},'alloying',50,'furnace',6,True,{'metallurgy':80})
recipe('alloy_rhenite','Сплавить ренит',{'rhenium_ore':2,'hafnium_ore':1,'tantalum_ore':1},{'rhenite_bar':1},'alloying',85,'furnace',7,True,{'metallurgy':95})
recipe('alloy_zartite','Сплавить зартит',{'zirconium_ore':2,'titanium_bar':1},{'zartite_bar':1},'alloying',60,'furnace',6)
recipe('alloy_haftite','Сплавить гафтит',{'hafnium_ore':2,'tantalum_ore':1},{'haftite_bar':1},'alloying',75,'furnace',6)
item('dianite_powder','Дианитовая пыль','resource',399,'crafting')
item('thrilium_powder','Трилиевая пыль','resource',850,'crafting')
recipe('dianite_powder','Измельчить компоненты дианита',{'diamond':1,'froanite_bar':1},{'dianite_powder':1},'crafting',70,'workbench',4)
recipe('alloy_dianite','Сплавить дианит',{'dianite_powder':1,'titanium_bar':2},{'dianite_bar':1},'alloying',75,'furnace',7)
recipe('alloy_thrilium','Сплавить трилий',{'thrilium_powder':1,'rhenite_bar':2},{'thrilium_bar':1},'alloying',95,'furnace',8)

for id,name,orig,lvl in [('quartz','Кварц',241,2),('tourmaline','Турмалин',242,10),('ruby','Рубин',243,40),('diamond','Алмаз',244,75),('sapphire','Сапфир',496,80),('emerald','Изумруд',497,85)]:
    item(id,name,'gem',orig,'geology',{'geology':lvl})

programs=[('dagger_disk','Дискета: кинжалы',222),('swords_disk','Дискета: мечи',170),('axes_disk','Дискета: топоры',182),('helmets_disk','Дискета: шлемы',199),('shields_disk','Дискета: щиты',200),('leggings_disk','Дискета: поножи',223),('armour_disk','Дискета: нагрудные доспехи',224),('poles_disk','Дискета: шесты',225),('tactical_shields_disk','Дискета: тактические щиты',459),('blank_disk','Чистая дискета',493),('castets_cd','CD: кастеты',725),('advanced_armour_cd','CD: продвинутые доспехи',604),('advanced_helmets_cd','CD: продвинутые шлемы',602),('advanced_leggings_cd','CD: продвинутые поножи',603),('laser_sword_flash','Программа: лазерные мечи',868)]
for id,name,orig in programs:item(id,name,'program',orig)

# Requirements and maximum cutting damage below come directly from object descriptions.
weapon_tiers=[('bronze','Бронзовый',1,1,1),('iron','Железный',15,10,20),('titanium','Титановый',30,20,45),('froanite','Фроанитовый',45,40,70),('dianite','Дианитовый',60,60,84)]
weapon_sets=[('dagger','кинжал','fencing',[212,214,216,218,220],[1,1,2,4,6],'dagger_disk',1),('sword','меч','fencing',[60,61,62,63,64],[5,9,12,16,19],'swords_disk',3),('axe','топор','heavy',[55,56,57,58,59],[6,10,14,20,25],'axes_disk',3),('pole','шест','piercing',[201,203,205,207,209],[5,9,12,18,22],'poles_disk',3)]
for suffix,label,skill,ids,damage,disc,qty in weapon_sets:
    for n,(tier,adjective,combat,slvl,craftlvl) in enumerate(weapon_tiers):
        id=tier+'_'+suffix
        row=item(id,adjective+' '+label,'weapon',ids[n],skill,{'combat':combat,skill:slvl},damage[n])
        row['provenance']['damage']='public-description';row['provenance']['requires']='public-description'
        recipe('forge_'+id,'Выковать '+adjective.lower()+' '+label,{tier+'_bar':qty,disc:1},{id:1,disc:1},'blacksmithing',craftlvl,'forge',5,original=(id=='bronze_dagger'))
item('club','Дубина','weapon',316,'heavy',{'combat':1,'heavy':1},3)
item('short_bow','Короткий лук','weapon',292,'medieval',{'combat':1,'medieval':1},4)
item('battle_bow','Боевой лук','weapon',538,'medieval',{'combat':30,'medieval':20},12)
item('crossbow','Арбалет','weapon',700,'medieval',{'combat':37,'medieval':30},16)
item('pistol','Пистолет','weapon',400,'automatic',{'combat':1,'automatic':1},5)
item('laser_pistol','Лазерный пистолет','weapon',286,'automatic',{'combat':15,'automatic':10},9)
item('rifle','Винтовка','weapon',401,'automatic',{'combat':37,'automatic':30},18)
item('laser_sword','Лазерный меч','weapon',574,'fencing',{'combat':70,'fencing':70},24)
item('black_sword','Чёрный меч','weapon',392,'fencing',{'combat':25,'fencing':15},12)
for id,name,orig in [('arrows','Стрелы',289),('arrow_heads','Наконечники стрел',288),('arrow_parts','Древки стрел',287),('bullets','Пули',716),('clip','Обойма',402),('battery_10','Батарея 10 кВт',245),('battery_100','Батарея 100 кВт',246),('battery_1000','Батарея 1000 кВт',247),('bowstring','Тетива',696),('crossbow_basis','Основа арбалета',699)]:item(id,name,'ammo' if id in ['arrows','bullets'] else 'component',orig)
recipe('cut_sticks','Нарезать палочки',{'wood':1},{'sticks':4},'woodwork',1,'workbench',2,True)
recipe('saw_planks','Распилить бревно',{'wood':2},{'planks':2},'woodwork',10,'workbench',3)
recipe('arrow_heads','Отлить наконечники',{'bronze_bar':1,'arrow_mould':1},{'arrow_heads':10,'arrow_mould':1},'crafting',1,'forge',3,True)
recipe('make_arrows','Собрать стрелы',{'sticks':1,'feather':1,'arrow_heads':1},{'arrows':3},'crafting',1,'workbench',2,True)
recipe('short_bow','Сделать короткий лук',{'wood':2,'thread':2},{'short_bow':1},'crafting',5,'workbench',4)
recipe('battle_bow','Сделать боевой лук',{'planks':2,'bowstring':1},{'battle_bow':1},'crafting',30,'workbench',4)
recipe('make_bowstring','Сделать тетиву',{'thread':4},{'bowstring':1},'tailoring',10,'loom',3)
recipe('crossbow_basis','Сделать основу арбалета',{'twig':2,'iron_bar':1},{'crossbow_basis':1},'crafting',40,'workbench',4)
recipe('crossbow','Собрать арбалет',{'crossbow_basis':1,'bowstring':1},{'crossbow':1},'crafting',45,'workbench',4)
recipe('gunpowder','Получить порох',{'saltpetre':2,'sulfur':1,'coal':1},{'gunpowder':2},'chemistry',35,'laboratory',4)
recipe('make_bullets','Отлить пули',{'lead_bar':1,'gunpowder':1},{'bullets':12},'crafting',25,'forge',3)

armor_tiers=[('bronze','Бронзовые',1,[35,144,226,24]),('plastic','Пластиковые',7,[36,145,227,25]),('iron','Железные',15,[37,146,228,26]),('kevlar','Кевларовые',22,[38,147,229,27]),('titanium','Титановые',30,[39,148,230,28]),('aerogel','Аэрогелевые',37,[40,149,231,29]),('froanite','Фроанитовые',45,[41,150,232,30]),('dianite','Дианитовые',60,[42,151,233,31]),('zartite','Зартитовые',40,[591,596,599,None]),('haftite','Гафтитовые',52,[592,597,600,None]),('rhenite','Ренитовые',70,[593,598,601,None]),('thrilium','Трилиевые',80,[594,677,678,None])]
for tier,label,combat,originals in armor_tiers:
    for j,(suffix,part,disc,qty) in enumerate([('helmet','шлем','helmets_disk',2),('armour','нагрудные доспехи','armour_disk',4),('leggings','поножи','leggings_disk',3),('shield','щит','shields_disk',2)]):
        if originals[j] is None:continue
        id=tier+'_'+suffix
        row=item(id,label+' — '+part,'armor',originals[j],requires={'combat':combat})
        row['provenance']['requires']='manual' if tier!='thrilium' else 'reconstruction'
        recipe('forge_'+id,'Пресс: '+label.lower()+' '+part,{tier+'_bar':qty,disc:1},{id:1,disc:1},'blacksmithing',max(1,combat),'forge',5)

for id,name,orig in [('armour_pattern','Выкройка: кожаный нагрудник',586),('pants_pattern','Выкройка: кожаные штаны',587),('boots_pattern','Выкройка: кожаные сапоги',588),('cape_pattern','Выкройка: кожаный плащ',589),('cap_pattern','Выкройка: кожаная шапка',590)]:item(id,name,'program',orig)
for suffix,name,orig,pat in [('armour','Кожаные нагрудные доспехи',581,'armour_pattern'),('pants','Кожаные штаны',582,'pants_pattern'),('boots','Кожаные сапоги',583,'boots_pattern'),('cape','Кожаный плащ',584,'cape_pattern'),('cap','Кожаная шапка',585,'cap_pattern')]:
    item('leather_'+suffix,name,'armor',orig,requires={'combat':1})
    recipe('sew_leather_'+suffix,'Сшить '+name.lower(),{'deer_hide':2,'thread':2,pat:1},{'leather_'+suffix:1,pat:1},'tailoring',40,'loom',5,original=suffix=='armour',requires={'intelligence':15})
item('shirt','Белая рубашка','armor',639)
recipe('spin_thread','Сплести нить',{'flax':2},{'thread':1},'tailoring',1,'loom',2,True)
recipe('weave_cloth','Соткать полотно',{'thread':3},{'cloth':1},'tailoring',5,'loom',3,True)
recipe('sew_shirt','Сшить рубашку',{'cloth':2,'thread':1},{'shirt':1},'tailoring',10,'loom',4,True,{'intelligence':15})
recipe('make_rubber','Смешать сырую резину',{'rubber_resin':1,'sulfur':1},{'raw_rubber':1},'chemistry',15,'laboratory',4,True,{'intelligence':15})
recipe('make_kevlar','Изготовить кевлар',{'raw_rubber':1,'web':2},{'kevlar_bar':1},'tailoring',50,'loom',5,True,{'intelligence':15})

foods=[('shrimp','Креветки',74,75,1,3),('trout','Форель',93,94,5,4),('salmon','Лосось',104,105,10,6),('crawfish','Раки',159,160,20,8),('pike','Щука',183,184,30,12),('tuna','Тунец',155,156,50,18),('armarin','Армарин',101,102,40,15),('kuruma','Курума',186,187,60,22),('squid','Кальмар',433,434,65,24),('ceratiasc','Цератиаск',436,437,70,28)]
for id,name,raw,cooked,lvl,heal in foods:
    item('raw_'+id,'Сырьё: '+name.lower(),'resource',raw,'fishing',{'fishing':lvl})
    row=item(id,name,'food',cooked,healing=heal)
    row['provenance']['healing']='manual' if id=='trout' else 'reconstruction'
    recipe('cook_'+id,'Приготовить '+name.lower(),{'raw_'+id:1},{id:1},'cooking',lvl,'campfire',3,original=id=='trout')
for id,name,raw,cooked,lvl,heal in [('chicken','Курятина',196,197,1,1),('pheasant','Фазан',269,275,5,4),('deer_meat','Оленина',485,486,20,12)]:
    item('raw_'+id,'Сырое мясо: '+name.lower(),'resource',raw)
    item(id,'Жареная '+name.lower(),'food',cooked,healing=heal)
    recipe('cook_'+id,'Зажарить '+name.lower(),{'raw_'+id:1},{id:1},'cooking',lvl,'campfire',3,original=id=='chicken')
for id,name,orig,heal in [('bread','Хлеб',335,10),('cheburek','Чебурек',338,24),('shashlik','Шашлык',273,32),('pie','Пирог',686,20)]:
    row=item(id,name,'food',orig,healing=heal);row['provenance']['healing']='manual' if id!='pie' else 'reconstruction'
recipe('mill_flour','Смолоть муку',{'wheat':2},{'flour':1},'cooking',1,'kitchen',2)
recipe('knead_dough','Замесить тесто',{'flour':1,'water':1},{'dough':1},'cooking',5,'kitchen',2)
recipe('mince_chicken','Приготовить куриный фарш',{'raw_chicken':1},{'forcemeat':1},'cooking',1,'kitchen',2,True)
recipe('bake_bread','Испечь хлеб',{'dough':1},{'bread':1},'cooking',12,'kitchen',4,True)
recipe('bake_cheburek','Приготовить чебурек',{'dough':1,'forcemeat':1},{'cheburek':1},'cooking',40,'kitchen',4,True)
recipe('cook_shashlik','Приготовить шашлык',{'raw_deer_meat':2,'raw_mushroom':1},{'shashlik':1},'cooking',50,'campfire',5,True)
recipe('bake_pie','Испечь пирог',{'dough':1,'cirbango':2},{'pie':1},'cooking',20,'kitchen',4)
for id,name,orig,heal in [('higrim_juice','Сок хигрима',623,2),('cirbango_juice','Сок кирбанго',327,2),('arans','Снадобье аранс',625,2),('letnos','Снадобье летнос',626,5),('first_aid','Аптечка',44,8),('ointment','Лечебная мазь',296,5)]:item(id,name,'medicine',orig,healing=heal)
recipe('higrim_juice','Выжать сок хигрима',{'higrim':2,'water':1},{'higrim_juice':1},'herbalism',1,'laboratory',3,True)
recipe('cirbango_juice','Выжать сок кирбанго',{'cirbango':2,'water':1},{'cirbango_juice':1},'herbalism',1,'laboratory',3)
recipe('arans','Приготовить снадобье аранс',{'krond_leaf':1,'krond_root':1,'higrim_juice':1},{'arans':1},'herbalism',30,'laboratory',4,True)
recipe('letnos','Приготовить снадобье летнос',{'red_berries':2,'krond_root':1,'water':1},{'letnos':1},'herbalism',40,'laboratory',4)

for id,name,orig in [('strek','STREK',542),('dexat','DEXAT',543),('vityl','VITYL',544),('intas','INTAS',545),('intul','INTUL',546),('engeck','ENGECK',547),('sufal','SUFAL',548),('alcat','ALCAT',549),('coned','CONED',550),('conti','CONTI',551),('wires','Провода',462),('main_board','Материнская плата',463),('electronic_lens','Электронная линза',464),('lens','Линза',396),('quartz_tube','Кварцевая трубка',397),('ruby_core','Рубиновый стержень',398)]:item(id,name,'component',orig)
item('modifier_strength','Модификатор силы 1','medicine',552,description='Исходный эффект: сила +1. Длительность и расчёты восстанавливаются.')
item('modifier_geologist','Модификатор геолога 12','medicine',562,description='Исходный эффект: сила +3, геология +1, металлургия +1. Длительность восстанавливается.')
recipe('modifier_strength','Собрать модификатор 1',{'engeck':1,'strek':1,'sufal':1},{'modifier_strength':1},'hightech',1,'laboratory',4,True,{'intelligence':40})
recipe('modifier_geologist','Собрать модификатор 12',{'engeck':3,'strek':1,'coned':1},{'modifier_geologist':1},'hightech',50,'laboratory',5,True,{'intelligence':40})
recipe('make_lens','Обработать линзу',{'quartz':1},{'lens':1},'crafting',20,'workbench',4)
recipe('quartz_tube','Обработать кварцевую трубку',{'quartz':2},{'quartz_tube':1},'crafting',30,'workbench',4)
recipe('ruby_core','Обработать рубиновый стержень',{'ruby':1},{'ruby_core':1},'crafting',50,'workbench',4)
item('scorpion_corpse','Труп скорпиона','resource',280)
for suffix,orig,lvl in [('a',608,15),('b',609,30),('c',610,50),('d',611,70)]:
    item('toxin_'+suffix,'Яд типа '+suffix.upper(),'medicine',orig)
    recipe('extract_toxin_'+suffix,'Выделить яд '+suffix.upper(),{'scorpion_corpse':1,'test_tube':1},{'toxin_'+suffix:1},'biology',lvl,'laboratory',4,requires={'intelligence':15})
for id,name,orig,skill in [('encyclopedia','Энциклопедия',45,'intelligence'),('hightech_book','Высокие технологии: книга',47,'hightech'),('chemistry_book','Химия: книга',51,'chemistry'),('biology_book','Биология: книга',52,'biology'),('science_book','Научная работа: книга',50,'physics')]:item(id,name,'book',orig,skill)
for id,name,orig,intellect in [('teleporter','Телепорт в Баратрон',153,20),('scanner','Сканер',279,10),('scanner_zeron','Сканер и телепорт в Зерон',489,30),('immortaler','Имморталер',595,1),('immortaler_xp','Имморталер XP',813,1)]:item(id,name,'tool',orig,requires={'intelligence':intellect})

# New district coordinates are reconstruction; they are never advertised as the original map.
def entity(id,type,name,x,z,**values):entities.append({'id':id,'type':type,'name':name,'x':x,'z':z,**values})
entity('bank','npc','Банк',0,0,state='bank')
entity('trader','npc','Торговец',-10,-2,state='trader')
entity('bob','npc','Отшельник Боб',5,15,state='guide')
for id,name,x,z in [('furnace','Доменная печь',11,-10),('forge','Кузнечный пресс',14,-10),('campfire','Костёр',14,13),('kitchen','Кухня',17,13),('workbench','Лазерный станок',12,-13),('loom','Швейный станок',8,-10),('laboratory','Лаборатория',9,-13)]:
    entity('station_'+id,'station',name,x,z,state=id)
for i in range(12):entity('tree_'+str(i),'resource','Дерево',-30+(i%4)*5,20+(i//4)*5,resource='wood',stock=60,level=1)
for i in range(10):entity('wheat_'+str(i),'resource','Пшеница',18+(i%5)*2,20+(i//5)*4,resource='wheat',stock=40,level=1)
for i in range(6):entity('flax_'+str(i),'resource','Лён',22+(i%3)*3,32+(i//3)*4,resource='flax',stock=40,level=1)
for i,(id,name) in enumerate([('cirbango','Дерево кирбанго'),('higrim','Куст хигрима'),('raw_mushroom','Грибы'),('krond_leaf','Листья кронда'),('krond_root','Корни кронда'),('red_berries','Красные ягоды'),('rubber_resin','Каучуковое дерево'),('web','Паутина')]):
    entity('plant_'+id,'resource',name,-24-(i%4)*5,34+(i//4)*8,resource=id,stock=30,level=1)
for i,(id,name,orig,lvl) in enumerate(ore_data):
    entity('mine_'+id,'resource',name+' жила',35+(i%5)*6,-35-(i//5)*8,resource=id+'_ore',stock=80,level=lvl)
entity('mine_coal','resource','Угольное месторождение',34,-27,resource='coal',stock=80,level=25)
for i,(id,name,lvl) in enumerate([('quartz','Кварц',2),('tourmaline','Турмалин',10),('ruby','Рубин',40),('diamond','Алмаз',75),('sapphire','Сапфир',80),('emerald','Изумруд',85),('sulfur','Сера',20),('unknown_ore','Неизвестная руда',30),('saltpetre','Селитра',30)]):
    entity('deposit_'+id,'resource',name,64+(i%3)*5,-30-(i//3)*8,resource=id,stock=30,level=lvl)
for i,(id,name,raw,cooked,lvl,heal) in enumerate(foods):entity('fish_'+id,'resource','Рыбное место: '+name.lower(),-45-(i%3)*5,-20-(i//3)*5,resource='raw_'+id,stock=45,level=lvl)
entity('well','resource','Колодец',-6,10,resource='water',stock=1000,level=1)
for prefix,name,x,z,level,hp,drop,count in [('chicken','Курица',-20,20,1,12,'raw_chicken',7),('rat','Крыса',25,-20,3,22,'engeck',6),('scorpion','Скорпион',50,-45,10,45,'scorpion_corpse',5),('drone','Боевой дроид',65,40,30,120,'plastic_bar',4),('deer','Олень',-42,45,20,60,'deer_hide',4),('pheasant','Фазан',-35,28,6,25,'raw_pheasant',4),('spider','Паук',80,-60,45,170,'web',3),('rotoz','Ротоз',82,50,50,200,'rotoz_hide',3),('zartul','Зартул',90,25,5,35,'sufal',3),('globbit','Глоббит',-55,55,9,40,'raw_deer_meat',3)]:
    for i in range(count):entity(prefix+'_'+str(i),'monster',name,x+(i%3)*4,z+(i//3)*5,level=level,hp=hp,maxHp=hp,alive=True,resource=drop)

locations=[
 {'id':'farmun','name':'Фармун','x':0,'z':8,'implemented':True,'provenance':'name-confirmed-layout-reconstruction','description':'Начальный район ремейка. Планировка и спавны новые.'},
 {'id':'forest','name':'Лес у Фармуна','x':-30,'z':20,'implemented':True,'provenance':'reconstruction'},
 {'id':'mine','name':'Рудник у Фармуна','x':35,'z':-35,'implemented':True,'provenance':'reconstruction'},
 {'id':'fields','name':'Поля у Фармуна','x':18,'z':20,'implemented':True,'provenance':'reconstruction'},
 {'id':'river','name':'Берег у Фармуна','x':-45,'z':-20,'implemented':True,'provenance':'reconstruction'},
 {'id':'baratron','name':'Баратрон','implemented':False,'provenance':'manual','description':'Оригинальный торговый узел с банком. Полная планировка ещё не перенесена.'},
 {'id':'setros','name':'Сетрос','implemented':False,'provenance':'manual'},
 {'id':'zeron','name':'Зерон','implemented':False,'provenance':'manual'},
 {'id':'saintroux','name':'Сайнтрокс','implemented':False,'provenance':'manual','description':'Место воскрешения персонажей с боевым уровнем 10 и выше.'},
 {'id':'targon','name':'Таргон','implemented':False,'provenance':'public-webdata'},
 {'id':'rubberix','name':'Остров Рубберикс','implemented':False,'provenance':'public-webdata'},
 {'id':'ramtor','name':'Остров Рамтор','implemented':False,'provenance':'public-webdata'},
 {'id':'shark_reef','name':'Риф акул','implemented':False,'provenance':'public-webdata'},
 {'id':'underground','name':'Подземелье','implemented':False,'provenance':'manual'}
]
world={
 'items':items,'recipes':recipes,'professions':[{'id':i,'name':n,'description':d,'category':'profession' if j<16 else 'combat'} for j,(i,n,d) in enumerate(professions)],'entities':entities,'locations':locations,
 'metadata':{'version':'0.1.0','baseline':'AWPlanet Classic manual and public Forever data snapshot','status':'playable reconstruction district; original complete parity pending','spawn':{'x':0,'z':8},'bounds':{'minX':-120,'maxX':120,'minZ':-120,'maxZ':120},'originalReferenceNamedObjects':888,'originalReferenceInteractionSlots':600,'balance':'All weights, prices, spawn coordinates, recipe quantities and durations are reconstructed unless provenance states otherwise. Catalog membership does not prove runtime implementation.','notImplemented':['full original world map','all original interactions','complete quests','original combat formulas','historical server balance','full original loot tables','boats and portal journeys','all item special effects'],'sources':['http://www.awplanet.com/p/blog-page_47.html','http://www.awplanet.com/p/blog-page_62.html','http://www.awplanet.com/p/blog-page_66.html','http://www.awplanet.com/p/blog-page_98.html','http://site.awplanet.com/client/single/build/webdata.data']},
 'forceModes':[{'id':i,'name':n,'intuition':l} for i,n,l in [('regeneration','Регенерация',1),('accuracy','Меткость',5),('reaction','Реакция',10),('protection','Защита',15),('shock','Шоковый удар',20),('berserk','Берсерк',25),('defense','Оборона',30),('attack','Нападение',35),('force_defense','Форс-защита',40)]]
}

# Cross-reference checks prevent invisible typo resources and unreachable station names.
ids={r['id'] for r in items}
assert len(ids)==len(items), 'Duplicate item ID'
assert len({r['id'] for r in recipes})==len(recipes), 'Duplicate recipe ID'
assert len({r['id'] for r in entities})==len(entities), 'Duplicate entity ID'
skills={r[0] for r in professions}
stations={r['state'] for r in entities if r['type']=='station'}
for r in recipes:
    assert r['skill'] in skills and r['station'] in stations, r
    for k,v in {**r['inputs'],**r['outputs']}.items():assert k in ids and isinstance(v,int) and v>0,(r['id'],k)
for e in entities:
    assert -120<=e['x']<=120 and -120<=e['z']<=120,e
    if 'resource' in e:assert e['resource'] in ids,e
(ROOT/'world.json').write_text(json.dumps(world,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'items':len(items),'recipes':len(recipes),'entities':len(entities),'professions':16,'combatSkills':6,'validation':'passed'}))
