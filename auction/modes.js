"use strict";

/*
 * Задания игры: что именно собирают игроки и как судья выбирает победителя.
 * `judge` — придаточное «что делает судья»: подставляется после «ChatGPT …» / «судья …».
 * `base` — обычная цель категории (её текст для промпта берётся из FRAMES в judge.js).
 * `kinds` / `notKinds` ограничивают, где задание доступно.
 *
 * `byKind` — название задания на языке категории: у музыкантов это «Лайнап фестиваля»,
 * у еды «Меню ужина», у животных «Зоопарк». Общее «Лучший набор» ничего не обещает и не
 * совпадает с тем, что на самом деле оценивает судья (FRAMES). Шаблоном это не собрать:
 * в русском прилагательное согласуется с родом («худший лайнап», но «худшее меню»),
 * поэтому формулировки заданы явно. Категории без своей строки берут общий текст.
 *
 * Поэтому у всех заданий byKind заполнен по всем доступным категориям, а общий текст —
 * запасной: одна формулировка на пятнадцать категорий даёт «банду из блюд». Образ разный:
 * лига суперзлодеев у музыкантов — «супергруппа зла», у еды её вообще нет (категория
 * не входит в `kinds`), у профессий — «штат суперзлодея».
 *
 * `short` отвечает на единственный вопрос игрока перед первым лотом — ЧТО собирать.
 * `judge` отвечает на второй вопрос — ПО КАКОМУ КРИТЕРИЮ ChatGPT оценит собранный набор
 * («оценивает угрозу миру, зловещую харизму и слаженность банды»). Правило без критерия
 * («считает, какая страна и правда спасёт») не говорит игроку, что собирать, — владелец просил так
 * не писать. Критерии в тексте — те же, что в `criteria` (у base — в FRAMES judge.js), только
 * под категорию: промпт судьи и подсказка игроку не должны расходиться.
 *
 * Один и тот же файл читают сервер и обе страницы.
 */


/*
 * Чем торгуют в категории — в форме, которая встаёт после «набор …» / «a set of …».
 * Нужно, чтобы подсказка говорила, ЧТО собирают: «выбирает самый бесполезный подарок»
 * не отвечает на вопрос игрока, он видит эту строку раньше первого лота.
 * Русский — родительный падеж множественного числа, английский — обычное множественное,
 * греческий — винительный множественного (после «από»). Падежи в русском и греческом не дают
 * собрать это шаблоном из одного слова, поэтому формы заданы явно.
 */
const KIND_ITEMS = {
  ru: {
    artist: "музыкантов", film: "фильмов", series: "сериалов", person: "известных людей",
    character: "персонажей", food: "блюд", city: "городов", country: "стран", place: "мест",
    animal: "животных", painting: "картин", company: "компаний", club: "клубов",
    profession: "профессий", invention: "изобретений",
  },
  en: {
    artist: "musicians", film: "films", series: "TV series", person: "famous people",
    character: "characters", food: "dishes", city: "cities", country: "countries", place: "landmarks",
    animal: "animals", painting: "paintings", company: "companies", club: "clubs",
    profession: "jobs", invention: "inventions",
  },
  el: {
    artist: "μουσικούς", film: "ταινίες", series: "σειρές", person: "διάσημους",
    character: "ήρωες", food: "πιάτα", city: "πόλεις", country: "χώρες", place: "αξιοθέατα",
    animal: "ζώα", painting: "πίνακες", company: "εταιρείες", club: "συλλόγους",
    profession: "επαγγέλματα", invention: "εφευρέσεις",
  },
};
const itemsFor = (kind, lang) => (KIND_ITEMS[lang] || KIND_ITEMS.ru)[kind] || (KIND_ITEMS[lang] || KIND_ITEMS.ru).artist;

const MODES = [
  {
    id: "base",
    icon: "🏆",
    title: "Лучший набор",
    short: "Классика: собери самое сильное",
    judge: "оценивает, чей набор топовее: самые громкие имена и легенды",
    byKind: {
      artist: { title: "Лайнап фестиваля", short: "Собери фестиваль, на который пойдут", judge: "оценивает, чей лайнап звёзднее: хедлайнеры, мировые хиты, стадионы" },
      film: { title: "Киномарафон", short: "Вечер, который смотрят не отрываясь", judge: "оценивает, чей марафон сильнее: культовая классика и шедевры" },
      series: { title: "Сезон сериалов", short: "Подписка, от которой не оторваться", judge: "оценивает, чья подписка топовее: культовые и самые обсуждаемые сериалы" },
      person: { title: "Ужин мечты", short: "Собери гостей, с которыми не заскучаешь", judge: "оценивает, чей стол звёзднее: самые громкие и легендарные гости" },
      character: { title: "Отряд героев", short: "Команда, которая выигрывает замес", judge: "оценивает, чей отряд сильнее: самые могучие и культовые герои" },
      food: { title: "Меню ужина", short: "Собери ужин, который работает целиком", judge: "оценивает, чьё меню топовее: легендарные блюда, которые любит весь мир" },
      city: { title: "Маршрут мечты", short: "Поездка, которую захочется повторить", judge: "оценивает, чей маршрут топовее: самые знаменитые и желанные города" },
      country: { title: "Кругосветка", short: "Собери маршрут вокруг света", judge: "оценивает, чья кругосветка топовее: самые желанные страны мира" },
      place: { title: "Тур по чудесам", short: "Места, ради которых стоит лететь", judge: "оценивает, чей тур топовее: величайшие и самые знаменитые чудеса" },
      animal: { title: "Зоопарк мечты", short: "Собери тех, на кого пойдут смотреть", judge: "оценивает, чей зоопарк круче: самые знаменитые и эффектные звери" },
      painting: { title: "Частная галерея", short: "Коллекция, которой можно хвастаться", judge: "оценивает, чья галерея топовее: знаменитые шедевры великих мастеров" },
      company: { title: "Инвестпортфель", short: "Собери портфель, который вырастет", judge: "оценивает, чей портфель сильнее: гиганты и лидеры рынка" },
      club: { title: "Спортивная империя", short: "Клубы, которые берут титулы", judge: "оценивает, чья империя сильнее: титулы, легенды, армия фанатов" },
      profession: { title: "Экипаж для острова", short: "Кто вытащит вас с необитаемого острова", judge: "оценивает, чей экипаж сильнее: кто прокормит, вылечит, построит плот" },
      invention: { title: "Груз в прошлое", short: "Изобретения, которые перепишут историю", judge: "оценивает, чей груз мощнее: изобретения, которые перевернули мир" },
    },
    t: {
      en: {
        title: "Best Set",
        short: "The classic: assemble the strongest set you can",
        judge: "rates whose set is stronger: the biggest names and legends",
        byKind: {
          artist: { title: "Festival Line-up", short: "Build a festival people would show up to", judge: "rates whose line-up is starrier: headliners, global hits, stadium acts" },
          film: { title: "Movie Marathon", short: "A night nobody wants to pause", judge: "rates whose marathon is stronger: cult classics and masterpieces" },
          series: { title: "Binge Season", short: "A subscription you cannot quit", judge: "rates whose binge list is stronger: cult, much-talked-about hits" },
          person: { title: "Dream Dinner", short: "Invite guests who keep the night alive", judge: "rates whose table is starrier: the biggest, most legendary guests" },
          character: { title: "Hero Squad", short: "A team that wins the brawl", judge: "rates whose squad is stronger: the mightiest, most iconic heroes" },
          food: { title: "Dinner Menu", short: "Build a dinner that works as a whole", judge: "rates whose menu is better: legendary dishes everyone loves" },
          city: { title: "Dream Trip", short: "A trip you would book all over again", judge: "rates whose trip is better: the most famous, sought-after cities" },
          country: { title: "Round the World", short: "Plot a route all the way around the globe", judge: "rates whose route is better: the world's most sought-after countries" },
          place: { title: "Wonders Tour", short: "Places worth getting on a plane for", judge: "rates whose tour is grander: the greatest, most famous wonders" },
          animal: { title: "Dream Zoo", short: "Gather the animals people queue up for", judge: "rates whose zoo is better: the most famous, spectacular animals" },
          painting: { title: "Private Gallery", short: "A collection worth bragging about", judge: "rates whose gallery is better: famous masterpieces by great masters" },
          company: { title: "Investment Portfolio", short: "Build a portfolio that only goes up", judge: "rates whose portfolio is stronger: giants and market leaders" },
          club: { title: "Sports Empire", short: "Clubs that actually lift trophies", judge: "rates whose empire is bigger: trophies, legends, a fan army" },
          profession: { title: "Island Crew", short: "Who gets you off a desert island", judge: "rates whose crew is stronger: hunters, medics, raft-builders" },
          invention: { title: "Cargo to the Past", short: "Inventions that rewrite history", judge: "rates whose cargo is mightier: inventions that changed the world" },
        },
      },
      el: {
        title: "Καλύτερο σετ",
        short: "Το κλασικό: φτιάξε το πιο δυνατό σετ",
        judge: "κρίνει ποιο σετ είναι πιο δυνατό: μεγάλα ονόματα και θρύλοι",
        byKind: {
          artist: { title: "Λάιναπ φεστιβάλ", short: "Φτιάξε ένα φεστιβάλ που θα πάει ο κόσμος", judge: "κρίνει ποιο λάιναπ είναι πιο λαμπερό: σταρ και παγκόσμιες επιτυχίες" },
          film: { title: "Μαραθώνιος ταινιών", short: "Μια βραδιά που δεν πατάς pause", judge: "κρίνει ποιος μαραθώνιος είναι πιο δυνατός: καλτ κλασικά και αριστουργήματα" },
          series: { title: "Σεζόν σειρών", short: "Μια συνδρομή που δεν την κλείνεις με τίποτα", judge: "κρίνει ποια συνδρομή είναι καλύτερη: καλτ και πολυσυζητημένες σειρές" },
          person: { title: "Δείπνο των ονείρων", short: "Μάζεψε καλεσμένους που δεν τους βαριέσαι", judge: "κρίνει ποιο τραπέζι έχει τα πιο μεγάλα και θρυλικά ονόματα" },
          character: { title: "Ομάδα ηρώων", short: "Μια ομάδα που κερδίζει τη μάχη", judge: "κρίνει ποια ομάδα είναι πιο δυνατή: ισχυροί, θρυλικοί ήρωες" },
          food: { title: "Μενού δείπνου", short: "Φτιάξε ένα δείπνο που στέκει ολόκληρο", judge: "κρίνει ποιο μενού είναι καλύτερο: θρυλικά πιάτα που αγαπούν όλοι" },
          city: { title: "Ταξίδι των ονείρων", short: "Ένα ταξίδι που θα θες να το ξανακάνεις", judge: "κρίνει ποιο ταξίδι είναι καλύτερο: οι πιο διάσημες, ποθητές πόλεις" },
          country: { title: "Γύρος του κόσμου", short: "Φτιάξε μια διαδρομή γύρω από τον κόσμο", judge: "κρίνει ποιος γύρος είναι καλύτερος: οι πιο ποθητές χώρες" },
          place: { title: "Τουρ στα θαύματα", short: "Μέρη που αξίζουν το αεροπλάνο", judge: "κρίνει ποιο τουρ είναι πιο εντυπωσιακό: τα πιο διάσημα θαύματα" },
          animal: { title: "Ιδανικός ζωολογικός", short: "Μάζεψε ζώα που αξίζουν την ουρά στο ταμείο", judge: "κρίνει ποιος ζωολογικός είναι καλύτερος: τα πιο διάσημα, εντυπωσιακά ζώα" },
          painting: { title: "Ιδιωτική γκαλερί", short: "Μια συλλογή για να καμαρώνεις", judge: "κρίνει ποια γκαλερί είναι καλύτερη: διάσημα έργα μεγάλων ζωγράφων" },
          company: { title: "Χαρτοφυλάκιο", short: "Φτιάξε ένα χαρτοφυλάκιο που ανεβαίνει", judge: "κρίνει ποιο χαρτοφυλάκιο είναι πιο δυνατό: κολοσσοί και ηγέτες αγοράς" },
          club: { title: "Αθλητική αυτοκρατορία", short: "Σύλλογοι που σηκώνουν τρόπαια", judge: "κρίνει ποια αυτοκρατορία είναι πιο δυνατή: τρόπαια, θρύλοι, οπαδοί" },
          profession: { title: "Πλήρωμα για το νησί", short: "Ποιοι θα σε βγάλουν από το έρημο νησί", judge: "κρίνει ποιο πλήρωμα είναι πιο δυνατό: κυνηγοί, γιατροί, μάστορες" },
          invention: { title: "Φορτίο στο παρελθόν", short: "Εφευρέσεις που ξαναγράφουν την ιστορία", judge: "κρίνει ποιο φορτίο έχει εφευρέσεις που άλλαξαν τον κόσμο" },
        },
      },
    },
  },
  {
    id: "worst",
    icon: "🔥",
    title: "Худший набор",
    short: "Набор {items}, где не сочетается вообще ничего",
    what: "нарочно провальный набор",
    criteria: "несовместимость, нелепость сочетаний, полная безнадёжность затеи",
    prompt:
      "Победитель — тот, чей набор нелепее и безнадёжнее: элементы не сочетаются, вместе выглядят абсурдно. " +
      "Чем хуже подобрано — тем выше оценка. Скучный средний набор — плохой результат, его оценивай низко.",
    judge: "оценивает, чей набор хуже всех: провалы и полный разнобой",
    byKind: {
      artist: { title: "Худший лайнап", short: "Фестиваль, с которого уходят после первой песни" },
      film: { title: "Худший киномарафон", short: "Вечер, который никто не досмотрит" },
      series: { title: "Худшая подписка", short: "Сезон, который бросают на первой серии" },
      person: { title: "Ужин-катастрофа", short: "Гости, которые перессорятся к десерту" },
      character: { title: "Отряд-катастрофа", short: "Команда, которая проиграет сама себе" },
      food: { title: "Худшее меню", short: "Ужин, который не доедят" },
      city: { title: "Маршрут-кошмар", short: "Поездка, о которой пожалеешь" },
      country: { title: "Кругосветка-кошмар", short: "Маршрут, в котором всё против тебя" },
      place: { title: "Тур разочарований", short: "Места, ради которых лететь не стоило" },
      animal: { title: "Зоопарк-провал", short: "Зверинец, мимо которого пройдут" },
      painting: { title: "Галерея безвкусицы", short: "Коллекция, которую стыдно показать" },
      company: { title: "Портфель банкрота", short: "Вложения, которые сгорят первыми" },
      club: { title: "Лига аутсайдеров", short: "Клубы, которые не выиграют ничего" },
      profession: { title: "Экипаж обречённых", short: "С такими на острове не выжить" },
      invention: { title: "Груз бесполезного", short: "Прошлое даже не заметит эту посылку" },
    },
    t: {
      en: {
        title: "Worst Set",
        short: "A set of {items} where nothing fits anything",
        judge: "rates whose set is the worst: flops and total mismatches",
        byKind: {
          artist: { title: "Worst Line-up", short: "A festival people quit after the first song" },
          film: { title: "Worst Marathon", short: "A movie night nobody makes it through" },
          series: { title: "Worst Subscription", short: "A season everyone drops on episode one" },
          person: { title: "Dinner Disaster", short: "Guests who will be at each other by dessert" },
          character: { title: "Doomed Squad", short: "A team that loses to itself" },
          food: { title: "Worst Menu", short: "A dinner that stays on the plate" },
          city: { title: "Trip from Hell", short: "A trip you will regret booking" },
          country: { title: "Nightmare World Tour", short: "A route with everything working against you" },
          place: { title: "Tour of Letdowns", short: "Places that were not worth the flight" },
          animal: { title: "Flop Zoo", short: "A zoo everyone walks straight past" },
          painting: { title: "Bad Taste Gallery", short: "A collection you would be ashamed to show" },
          company: { title: "Bankrupt Portfolio", short: "The investments that burn first" },
          club: { title: "League of Losers", short: "Clubs that will never win a thing" },
          profession: { title: "Doomed Crew", short: "Nobody survives the island with this lot" },
          invention: { title: "Useless Cargo", short: "The past will not even notice this parcel" },
        },
      },
      el: {
        title: "Χειρότερο σετ",
        short: "Ένα σετ από {items} που δεν ταιριάζουν πουθενά",
        judge: "κρίνει ποιο σετ είναι χειρότερο: φιάσκα που δεν δένουν καθόλου",
        byKind: {
          artist: { title: "Χειρότερο λάιναπ", short: "Φεστιβάλ που το παρατάς στο πρώτο τραγούδι" },
          film: { title: "Χειρότερος μαραθώνιος", short: "Βραδιά που δεν τη βγάζει κανείς μέχρι το τέλος" },
          series: { title: "Χειρότερη συνδρομή", short: "Σεζόν που την παρατάς στο πρώτο επεισόδιο" },
          person: { title: "Δείπνο-καταστροφή", short: "Καλεσμένοι που θα τσακωθούν μέχρι το γλυκό" },
          character: { title: "Ομάδα-καταστροφή", short: "Ομάδα που θα χάσει από τον εαυτό της" },
          food: { title: "Χειρότερο μενού", short: "Δείπνο που θα μείνει στο πιάτο" },
          city: { title: "Ταξίδι-εφιάλτης", short: "Ταξίδι που θα το μετανιώσεις" },
          country: { title: "Γύρος-εφιάλτης", short: "Διαδρομή όπου όλα είναι εναντίον σου" },
          place: { title: "Τουρ απογοητεύσεων", short: "Μέρη που δεν άξιζαν το αεροπλάνο" },
          animal: { title: "Ζωολογικός-φιάσκο", short: "Ζωολογικός που τον προσπερνάς" },
          painting: { title: "Γκαλερί κακογουστιάς", short: "Συλλογή που ντρέπεσαι να τη δείξεις" },
          company: { title: "Σίγουρη χρεοκοπία", short: "Επενδύσεις που θα καούν πρώτες" },
          club: { title: "Λίγκα των ουραγών", short: "Σύλλογοι που δεν θα κερδίσουν τίποτα" },
          profession: { title: "Χαμένο πλήρωμα", short: "Με αυτούς δεν βγαίνει επιβίωση στο νησί" },
          invention: { title: "Άχρηστο φορτίο", short: "Το παρελθόν δεν θα προσέξει καν αυτό το πακέτο" },
        },
      },
    },
  },
  {
    id: "villains",
    icon: "😈",
    title: "Лига суперзлодеев",
    short: "Собери тех, кто захватит мир",
    kinds: ["character", "person", "animal", "artist", "club", "company", "profession"],
    what: "команда суперзлодеев для захвата мира",
    criteria: "угроза миру, зловещая харизма, взаимное усиление участников банды",
    prompt:
      "Оцени, насколько набор годится в злодейскую лигу: кто наводит ужас, кто отвечает за коварный план, " +
      "кто просто харизматичный псих. Милые и безобидные участники — минус, если только они не пугают своей милотой.",
    judge: "оценивает, чья банда опаснее: сила, власть, злодейская харизма",
    byKind: {
      artist: { title: "Банда со сцены", short: "Музыканты, из которых вышли бы отличные злодеи", judge: "оценивает, чьи музыканты опаснее: мрачный образ, скандалы, армия фанатов" },
      person: { title: "Совет злодеев", short: "Знаменитости, которые поделят мир между собой", judge: "оценивает, чей совет опаснее: власть, деньги, влияние на миллионы" },
      character: { title: "Лига суперзлодеев", short: "Злодеи, против которых у героев нет шансов", judge: "оценивает, чья лига опаснее: самые могущественные и коварные злодеи" },
      animal: { title: "Звериная орда", short: "Звери, от которых человечеству не отбиться", judge: "оценивает, чья орда страшнее: клыки, яд, размер и численность" },
      club: { title: "Клубы-злодеи", short: "Клубы, которые заберут весь спорт себе", judge: "оценивает, чьи клубы опаснее: деньги, влияние, армия фанатов" },
      company: { title: "Корпорация зла", short: "Корпорации, которые тайно правят миром", judge: "оценивает, чья корпорация опаснее: деньги, данные, власть над людьми" },
      profession: { title: "Штат суперзлодея", short: "Спецы, без которых логово не работает", judge: "оценивает, чей штат опаснее: наука, взлом, оружие и охрана" },
    },
    t: {
      en: {
        title: "Supervillain League",
        short: "Assemble the crew that takes over the world",
        judge: "rates whose gang is deadlier: power, influence, villainous charisma",
        byKind: {
          artist: { title: "Band Gone Bad", short: "Musicians who would make excellent villains", judge: "rates whose musicians are scarier: dark image, scandals, fan armies" },
          person: { title: "Council of Villains", short: "Celebrities who carve up the world between them", judge: "rates whose council is deadlier: power, money, influence over millions" },
          character: { title: "Supervillain League", short: "Villains the heroes cannot possibly beat", judge: "rates whose league is deadlier: the most powerful, cunning villains" },
          animal: { title: "Beast Horde", short: "Animals humanity could not fight off", judge: "rates whose horde is scarier: fangs, venom, size and numbers" },
          club: { title: "Villain Clubs", short: "Clubs that would take the whole sport over", judge: "rates whose clubs are more dangerous: money, influence, fan armies" },
          company: { title: "Evil Corporation", short: "Corporations that secretly run the world", judge: "rates whose corporation is more sinister: money, data, control" },
          profession: { title: "Evil Lair Staff", short: "The specialists every evil lair needs", judge: "rates whose staff is deadlier: science, hacking, weapons and security" },
        },
      },
      el: {
        title: "Λίγκα σούπερ κακών",
        short: "Μάζεψε αυτούς που θα κατακτήσουν τον κόσμο",
        judge: "κρίνει ποια συμμορία είναι πιο επικίνδυνη: δύναμη, επιρροή, σκοτεινή γοητεία",
        byKind: {
          artist: { title: "Μπάντα κακοποιών", short: "Μουσικοί που θα έκαναν εξαιρετικούς κακούς", judge: "κρίνει ποιοι μουσικοί είναι πιο απειλητικοί: σκοτεινή εικόνα, σκάνδαλα, οπαδοί" },
          person: { title: "Συμβούλιο κακών", short: "Διάσημοι που θα μοιράσουν τον κόσμο μεταξύ τους", judge: "κρίνει ποιο συμβούλιο είναι πιο επικίνδυνο: εξουσία, χρήμα, επιρροή" },
          character: { title: "Λίγκα σούπερ κακών", short: "Κακοί που οι ήρωες δεν τους βγάζουν με τίποτα", judge: "κρίνει ποια λίγκα είναι πιο επικίνδυνη: ισχυροί και πανούργοι κακοί" },
          animal: { title: "Ορδή των ζώων", short: "Ζώα που η ανθρωπότητα δεν θα σταματούσε", judge: "κρίνει ποια ορδή είναι πιο τρομακτική: δόντια, δηλητήριο, μέγεθος, πλήθος" },
          club: { title: "Σύλλογοι κακών", short: "Σύλλογοι που θα πάρουν όλο το άθλημα δικό τους", judge: "κρίνει ποιοι σύλλογοι είναι πιο επικίνδυνοι: χρήμα, επιρροή, στρατός οπαδών" },
          company: { title: "Εταιρεία του κακού", short: "Εταιρείες που κυβερνούν κρυφά τον κόσμο", judge: "κρίνει ποια εταιρεία είναι πιο σκοτεινή: χρήμα, δεδομένα, έλεγχος ανθρώπων" },
          profession: { title: "Προσωπικό του κακού", short: "Οι ειδικοί που θέλει κάθε κρησφύγετο κακού", judge: "κρίνει ποιο προσωπικό είναι πιο επικίνδυνο: επιστήμη, χάκινγκ, όπλα, φύλαξη" },
        },
      },
    },
  },
  {
    id: "apocalypse",
    icon: "☢️",
    title: "Пережить апокалипсис",
    short: "Собери то, с чем переживёшь конец света",
    // Картины/музыканты/кино/сериалы для выживания бесполезны одинаково — судья ставит всем
    // низкие оценки и ранжирует ровно как в обычном задании, то есть выбор ни на что не влияет.
    // У профессий базовая цель и так «экипаж для выживания» — вышло бы два тайла с одной целью.
    notKinds: ["painting", "artist", "film", "series", "profession"],
    what: "набор для выживания после конца света",
    criteria: "практическая польза, живучесть, способность прокормить и защитить",
    prompt: "Оценивай холодно и практично: что реально поможет выжить, а что окажется бесполезным грузом.",
    judge: "оценивает, с чем дольше протянешь: еда, вода, защита, тепло",
    byKind: {
      person: { title: "Бункер знаменитостей", short: "Кого берёшь в бункер, когда всё рухнуло", judge: "оценивает, кто полезнее в бункере: добудет еду, починит, защитит" },
      character: { title: "Отряд выживших", short: "Кто вытащит тебя из конца света", judge: "оценивает, чей отряд живучее: сила, навыки выживания, защита своих" },
      food: { title: "Запас на бункер", short: "Чем питаться, когда магазинов больше нет", judge: "оценивает, что сытнее и дольше хранится без холодильника" },
      city: { title: "Где пересидеть", short: "Города, в которых есть шанс дожить до весны", judge: "оценивает, где проще выжить: вода, еда, укрытия, подальше от угроз" },
      country: { title: "Куда бежать", short: "Страны, в которых пересидишь конец света", judge: "оценивает, где проще пересидеть: еда, вода, изоляция от мира" },
      place: { title: "Последнее убежище", short: "Где забаррикадироваться, когда всё рухнуло", judge: "оценивает, где надёжнее укрыться: толстые стены, запасы, изоляция" },
      animal: { title: "Звери-напарники", short: "Кто прокормит и защитит после конца света", judge: "оценивает, какие звери полезнее: кормят, охраняют, возят грузы" },
      company: { title: "Корпорации-бункеры", short: "Чьи склады и заводы спасут после краха", judge: "оценивает, чьи компании полезнее без интернета: еда, топливо, инструменты" },
      club: { title: "Кланы со стадионов", short: "Стадион как крепость, фанаты как армия", judge: "оценивает, чей клан сильнее: большие стадионы и преданные фанаты" },
      invention: { title: "Что взять в бункер", short: "Изобретения, без которых не выжить", judge: "оценивает, какие изобретения дадут еду, воду, тепло, защиту" },
    },
    t: {
      en: {
        title: "Apocalypse Survival",
        short: "Gather what gets you through the end of the world",
        judge: "rates what keeps you alive longest: food, water, shelter, warmth",
        byKind: {
          person: { title: "Celebrity Bunker", short: "Who you take into the bunker when it all falls apart", judge: "rates who's most useful in the bunker: food, repairs, defence" },
          character: { title: "Survivor Squad", short: "Who drags you out of the apocalypse", judge: "rates whose squad lasts longest: strength, survival skills, protecting others" },
          food: { title: "Bunker Supplies", short: "What you eat once the shops are gone", judge: "rates what's most filling and keeps longest without a fridge" },
          city: { title: "Where to Sit It Out", short: "Cities where you might live to see the spring", judge: "rates where survival is easiest: water, food, shelter, few threats" },
          country: { title: "Where to Run", short: "Countries you could sit the apocalypse out in", judge: "rates where it's easiest to hide out: food, water, isolation" },
          place: { title: "Last Refuge", short: "Where to barricade yourself when it all falls apart", judge: "rates the safest hideout: thick walls, supplies, isolation" },
          animal: { title: "Survival Partners", short: "Who feeds you and guards you after the collapse", judge: "rates which animals help most: food, guarding, carrying loads" },
          company: { title: "Bunker Corporations", short: "Whose warehouses and factories save you after the crash", judge: "rates whose companies help most offline: food, fuel, tools" },
          club: { title: "Stadium Clans", short: "The stadium is the fortress, the fans are the army", judge: "rates whose clan holds out best: big stadiums, loyal fans" },
          invention: { title: "Bunker Cargo", short: "The inventions you cannot survive without", judge: "rates which inventions give food, water, warmth and protection" },
        },
      },
      el: {
        title: "Μετά την αποκάλυψη",
        short: "Μάζεψε ό,τι θα σε βγάλει από το τέλος του κόσμου",
        judge: "κρίνει με τι αντέχεις περισσότερο: φαγητό, νερό, καταφύγιο, ζέστη",
        byKind: {
          person: { title: "Καταφύγιο διάσημων", short: "Ποιους παίρνεις στο καταφύγιο όταν όλα καταρρέουν", judge: "κρίνει ποιος χρησιμεύει στο καταφύγιο: φαγητό, επισκευές, άμυνα" },
          character: { title: "Ομάδα επιβίωσης", short: "Ποιοι θα σε βγάλουν από την αποκάλυψη", judge: "κρίνει ποια ομάδα αντέχει περισσότερο: δύναμη, επιβίωση, προστασία των άλλων" },
          food: { title: "Προμήθειες καταφυγίου", short: "Τι θα τρως όταν δεν υπάρχουν μαγαζιά", judge: "κρίνει τι χορταίνει και κρατάει περισσότερο χωρίς ψυγείο" },
          city: { title: "Πού θα κρυφτείς", short: "Πόλεις όπου έχεις ελπίδα να δεις άνοιξη", judge: "κρίνει πού επιβιώνεις πιο εύκολα: νερό, φαγητό, καταφύγια, λίγοι κίνδυνοι" },
          country: { title: "Πού να το σκάσεις", short: "Χώρες όπου βγάζεις το τέλος του κόσμου", judge: "κρίνει πού κρύβεσαι πιο εύκολα: φαγητό, νερό, απομόνωση" },
          place: { title: "Τελευταίο καταφύγιο", short: "Πού θα ταμπουρωθείς όταν όλα καταρρέουν", judge: "κρίνει το πιο ασφαλές κρησφύγετο: χοντροί τοίχοι, προμήθειες, απομόνωση" },
          animal: { title: "Σύντροφοι επιβίωσης", short: "Ποιοι θα σε θρέψουν και θα σε φυλάξουν", judge: "κρίνει ποια ζώα βοηθούν περισσότερο: τροφή, φύλαξη, μεταφορά" },
          company: { title: "Εταιρείες-καταφύγια", short: "Ποιανού οι αποθήκες και τα εργοστάσια σώζουν", judge: "κρίνει ποιες εταιρείες βοηθούν χωρίς ίντερνετ: τρόφιμα, καύσιμα, εργαλεία" },
          club: { title: "Κλαν των γηπέδων", short: "Το γήπεδο κάστρο, οι οπαδοί στρατός", judge: "κρίνει ποιο κλαν αντέχει: μεγάλα γήπεδα, πιστοί οπαδοί" },
          invention: { title: "Φορτίο καταφυγίου", short: "Εφευρέσεις χωρίς τις οποίες δεν επιβιώνεις", judge: "κρίνει ποιες εφευρέσεις δίνουν φαγητό, νερό, ζέστη, προστασία" },
        },
      },
    },
  },
  {
    id: "party",
    icon: "🎉",
    title: "Вечеринка года",
    short: "Собери вечеринку, с которой никто не уйдёт",
    what: "вечеринка, на которую все захотят попасть",
    criteria: "веселье, неожиданность, атмосфера, о чём будут вспоминать год",
    prompt: "Скучное — минус, даже если дорогое и статусное. Важнее всего, будет ли весело.",
    judge: "оценивает, чья вечеринка круче: самое весёлое, шумное, безбашенное",
    // invention намеренно без своей строки title: общая «Вечеринка года» подходит гаджетам
    // как есть, а тест на запасной текст держится именно за эту пару.
    byKind: {
      artist: { title: "Музыка на вечеринке", short: "Кто выступает у тебя до самого утра", judge: "оценивает, чья музыка качает: танцевальные хиты, которые знают все" },
      film: { title: "Кино на вечеринке", short: "Что крутить на экране, когда все пришли", judge: "оценивает, какие фильмы заводят компанию: комедии, экшен, цитаты наизусть" },
      series: { title: "Марафон до утра", short: "Что включить, чтобы никто не ушёл спать", judge: "оценивает, что не даст уснуть: захватывающие сериалы с клиффхэнгерами" },
      person: { title: "Список гостей", short: "Кого позвать, чтобы вечер запомнили", judge: "оценивает, чьи гости зажигательнее: шутники, шоумены, душа компании" },
      character: { title: "Гости из вымысла", short: "Позови героев, которые разнесут вечеринку", judge: "оценивает, чьи герои зажгут сильнее: весельчаки, хулиганы, бунтари" },
      food: { title: "Стол для вечеринки", short: "Еда, которую сметут до полуночи", judge: "оценивает, что сметут первым: закуски, которые любят все" },
      city: { title: "Где гуляем", short: "Города, в которых ночь не кончается", judge: "оценивает, где ночная жизнь круче: клубы, бары, тусовки до утра" },
      country: { title: "Тур по вечеринкам", short: "Страны, в которых не спят по ночам", judge: "оценивает, где веселее гулять: ночная жизнь, фестивали, карнавалы" },
      place: { title: "Где закатить рейв", short: "Выбери, где танцевать там, где нельзя", judge: "оценивает, где рейв безумнее: самые неожиданные и запретные места" },
      animal: { title: "Звери на вечеринке", short: "Гости с лапами, копытами и клыками", judge: "оценивает, чьи звери устроят больше веселья и хаоса" },
      painting: { title: "Картины на стенах", short: "Чем завесить стены, чтобы все залипли", judge: "оценивает, чьи картины эффектнее: яркие, дерзкие, есть что обсудить" },
      company: { title: "Кто платит за вечер", short: "Спонсоры, которые оплатят весь банкет", judge: "оценивает, чьи спонсоры щедрее: деньги, еда, выпивка, подарки" },
      club: { title: "После матча", short: "С чьими фанатами гулять после матча", judge: "оценивает, чьи фанаты гуляют громче: песни, кричалки, праздник до утра" },
      profession: { title: "Команда праздника", short: "Спецы, которые вытянут любой праздник", judge: "оценивает, кто обеспечит музыку, еду, шоу и порядок" },
      invention: { title: "Гаджеты для вечера", short: "Гаджеты, без которых вечеринка не та", judge: "оценивает, какие изобретения веселее: музыка, свет, игры, шоу" },
    },
    t: {
      en: {
        title: "Party of the Year",
        short: "Throw a party nobody wants to leave",
        judge: "rates whose party is better: the loudest, wildest, most fun",
        byKind: {
          artist: { title: "Who's Playing", short: "Who is on stage at your place till sunrise", judge: "rates whose music moves the floor: dance hits everyone knows" },
          film: { title: "Party Screening", short: "What goes on the screen once everyone is in", judge: "rates which films fire up a crowd: comedies, action, cult quotes" },
          series: { title: "All-Nighter Binge", short: "What keeps everybody from going to bed", judge: "rates what keeps everyone awake: gripping shows with cliffhangers" },
          person: { title: "The Guest List", short: "Who to invite so the night gets remembered", judge: "rates whose guests are more fun: jokers, showmen, party animals" },
          character: { title: "Fictional Guests", short: "Invite the characters who wreck the place", judge: "rates whose characters party harder: pranksters, troublemakers, rebels" },
          food: { title: "Party Spread", short: "Food that is gone before midnight", judge: "rates what gets eaten first: snacks everybody loves" },
          city: { title: "Where We Go Out", short: "Cities where the night never ends", judge: "rates whose nightlife is better: clubs, bars, parties till dawn" },
          country: { title: "Party World Tour", short: "Countries that simply do not sleep", judge: "rates where the party's better: nightlife, festivals, carnivals" },
          place: { title: "Where to Rave", short: "Pick the spot where dancing is not allowed", judge: "rates the wildest rave spot: the most unexpected, forbidden places" },
          animal: { title: "Animals Invited", short: "Guests with paws, hooves and fangs", judge: "rates whose animals bring more fun and chaos" },
          painting: { title: "Art on the Walls", short: "What goes on the walls to hypnotise everyone", judge: "rates whose art grabs attention: bold, bright, full of stories" },
          company: { title: "Who Pays for It", short: "Sponsors who pick up the whole tab", judge: "rates whose sponsors are more generous: cash, food, drinks, gifts" },
          club: { title: "Afterparty Crew", short: "Whose fans you celebrate with after the match", judge: "rates whose fans party louder: songs, chants, celebrating till dawn" },
          profession: { title: "The Party Crew", short: "The pros who can save any party", judge: "rates who covers music, food, entertainment and security" },
          invention: { title: "Party Gadgets", short: "The gadgets a party is nothing without", judge: "rates which inventions add more fun: music, lights, games, shows" },
        },
      },
      el: {
        title: "Πάρτι της χρονιάς",
        short: "Φτιάξε ένα πάρτι που δεν φεύγει κανείς",
        judge: "κρίνει ποιο πάρτι είναι καλύτερο: το πιο θορυβώδες, τρελό, διασκεδαστικό",
        byKind: {
          artist: { title: "Ποιοι παίζουν", short: "Ποιοι παίζουν στο πάρτι σου μέχρι το πρωί", judge: "κρίνει ποια μουσική σηκώνει κόσμο: χορευτικές επιτυχίες που ξέρουν όλοι" },
          film: { title: "Προβολή στο πάρτι", short: "Τι παίζει στην οθόνη μόλις μαζευτούν όλοι", judge: "κρίνει ποιες ταινίες ξεσηκώνουν την παρέα: κωμωδίες, δράση, ατάκες" },
          series: { title: "Μαραθώνιος ως το πρωί", short: "Τι θα βάλεις για να μη πάει κανείς για ύπνο", judge: "κρίνει τι κρατάει όλους ξύπνιους: σειρές γεμάτες αγωνία" },
          person: { title: "Λίστα καλεσμένων", short: "Ποιους καλείς για να μείνει η βραδιά στην ιστορία", judge: "κρίνει ποιοι καλεσμένοι φέρνουν κέφι: πλακατζήδες, σόουμεν, ψυχή της παρέας" },
          character: { title: "Ήρωες στο πάρτι", short: "Κάλεσε ήρωες που θα διαλύσουν το σπίτι", judge: "κρίνει ποιοι ήρωες ξεσαλώνουν περισσότερο: φαρσέρ, ταραχοποιοί, επαναστάτες" },
          food: { title: "Μπουφές πάρτι", short: "Φαγητό που εξαφανίζεται πριν τα μεσάνυχτα", judge: "κρίνει τι θα φαγωθεί πρώτο: σνακ που αγαπούν όλοι" },
          city: { title: "Πού βγαίνουμε", short: "Πόλεις όπου η νύχτα δεν τελειώνει ποτέ", judge: "κρίνει τη νυχτερινή ζωή: κλαμπ, μπαρ, πάρτι ως το πρωί" },
          country: { title: "Παγκόσμιο πάρτι τουρ", short: "Χώρες που απλώς δεν κοιμούνται", judge: "κρίνει πού γλεντάνε καλύτερα: νυχτερινή ζωή, φεστιβάλ, καρναβάλια" },
          place: { title: "Πού θα γίνει ρέιβ", short: "Διάλεξε πού θα χορέψεις εκεί που δεν επιτρέπεται", judge: "κρίνει το πιο τρελό σημείο για ρέιβ: απρόσμενα, απαγορευμένα μέρη" },
          animal: { title: "Ζώα καλεσμένα", short: "Καλεσμένοι με πατούσες, οπλές και δόντια", judge: "κρίνει με ποια ζώα έχει περισσότερη πλάκα και χάος" },
          painting: { title: "Τέχνη στους τοίχους", short: "Τι θα κρεμάσεις για να κολλήσουν όλοι", judge: "κρίνει ποιοι πίνακες τραβούν τα βλέμματα: τολμηροί, φωτεινοί, με ιστορία" },
          company: { title: "Ποιος πληρώνει", short: "Χορηγοί που θα πληρώσουν όλο τον λογαριασμό", judge: "κρίνει ποιοι χορηγοί είναι πιο γενναιόδωροι: χρήμα, φαγητό, ποτά, δώρα" },
          club: { title: "Αφτερπάρτι", short: "Με ποιανού τους οπαδούς γιορτάζεις μετά", judge: "κρίνει ποιανού οι οπαδοί γλεντάνε πιο δυνατά: τραγούδια, συνθήματα, γιορτή" },
          profession: { title: "Ομάδα του πάρτι", short: "Οι ειδικοί που σώζουν κάθε γιορτή", judge: "κρίνει ποιοι καλύπτουν μουσική, φαγητό, σόου και τάξη" },
          invention: { title: "Μαραφέτια πάρτι", short: "Τα μαραφέτια χωρίς τα οποία δεν γίνεται πάρτι", judge: "κρίνει ποιες εφευρέσεις φέρνουν κέφι: μουσική, φώτα, παιχνίδια, σόου" },
        },
      },
    },
  },
  {
    id: "museum",
    icon: "🏛️",
    title: "Музей странностей",
    short: "Собери то, на что придут поглазеть",
    what: "экспозиция музея странного и удивительного",
    criteria: "необычность, зрелищность, желание сфотографировать и показать друзьям",
    prompt: "Ценится странность и зрелищность, а не ценность или качество. Предсказуемое и обыденное — низкая оценка.",
    judge: "оценивает, чьи экспонаты страннее: редкое, диковинное, невероятное",
    byKind: {
      artist: { title: "Музей музыки", short: "Кого выставить в музее музыки", judge: "оценивает, чьи музыканты страннее: эпатаж, безумные образы, скандалы" },
      film: { title: "Музей кино", short: "Фильмы, которым место в витрине", judge: "оценивает, чьи фильмы безумнее: самые странные сюжеты и идеи" },
      series: { title: "Зал сериалов", short: "Сериалы, на которые смотрят как на диковину", judge: "оценивает, чьи сериалы чуднее: самые дикие и странные сюжеты" },
      person: { title: "Кабинет диковин", short: "Люди, на которых сходятся поглазеть", judge: "оценивает, чьи люди чудаковатее: самые странные судьбы и выходки" },
      character: { title: "Зал вымышленных", short: "Герои, ради которых купят билет", judge: "оценивает, чьи герои причудливее: самый странный вид и способности" },
      food: { title: "Музей еды", short: "Блюда, на которые смотрят с ужасом и восторгом", judge: "оценивает, чьи блюда страннее на вид и вкус" },
      city: { title: "Музей городов", short: "Города, которые сами похожи на экспонат", judge: "оценивает, чьи города необычнее: странные улицы, обычаи, архитектура" },
      country: { title: "Музей стран", short: "Страны, которые сами как кабинет диковин", judge: "оценивает, у чьих стран самые странные обычаи и законы" },
      place: { title: "Зал чудес", short: "Места, от которых глаза на лоб", judge: "оценивает, чьи места диковиннее: самые странные и невероятные на вид" },
      animal: { title: "Кабинет редкостей", short: "Звери, которых больше нигде не покажут", judge: "оценивает, чьи звери диковиннее: самые редкие и странные" },
      painting: { title: "Зал безумных картин", short: "Картины, у которых зависают с открытым ртом", judge: "оценивает, чьи картины безумнее: самые странные и загадочные сюжеты" },
      company: { title: "Музей корпораций", short: "Фирмы, чья история сама как экспонат", judge: "оценивает, у чьих компаний самая чудная история" },
      club: { title: "Музей курьёзов", short: "Клубы, чьи истории не придумаешь", judge: "оценивает, у чьих клубов самые курьёзные истории" },
      profession: { title: "Музей профессий", short: "Работы, в которые не верят, пока не увидят", judge: "оценивает, чьи профессии диковиннее: самые редкие и невероятные работы" },
      invention: { title: "Зал чудо-техники", short: "Изобретения, которым место под стеклом", judge: "оценивает, чьи изобретения чуднее: самые странные и удивительные штуки" },
    },
    t: {
      en: {
        title: "Museum of Oddities",
        short: "Gather the things people show up just to gawk at",
        judge: "rates whose exhibits are stranger: rare, bizarre, unbelievable",
        byKind: {
          artist: { title: "Museum of Music", short: "Who goes on display in a music museum", judge: "rates whose musicians are weirder: wild looks, antics, scandals" },
          film: { title: "Museum of Film", short: "Films that belong in a display case", judge: "rates whose films are crazier: the strangest plots and ideas" },
          series: { title: "Hall of Series", short: "Shows people study like curiosities", judge: "rates whose shows are odder: the wildest, strangest plots" },
          person: { title: "Cabinet of Curios", short: "People everyone turns up to gawk at", judge: "rates whose people are quirkier: the oddest lives and antics" },
          character: { title: "Hall of Fiction", short: "Characters worth buying a ticket for", judge: "rates whose characters are more bizarre: strangest looks and powers" },
          food: { title: "Museum of Food", short: "Dishes people stare at in horror and awe", judge: "rates whose dishes look and taste the strangest" },
          city: { title: "Museum of Cities", short: "Cities that are exhibits all by themselves", judge: "rates whose cities are more unusual: odd streets, customs, buildings" },
          country: { title: "Museum of Nations", short: "Countries that are cabinets of curiosities already", judge: "rates whose countries have the strangest customs and laws" },
          place: { title: "Hall of Wonders", short: "Places that make your jaw drop", judge: "rates whose places are more bizarre: the most unreal sights" },
          animal: { title: "Cabinet of Rarities", short: "Animals no other zoo will ever show", judge: "rates whose animals are more exotic: the rarest and strangest" },
          painting: { title: "Hall of Mad Art", short: "Paintings people stand in front of, mouth open", judge: "rates whose paintings are crazier: the strangest, most puzzling scenes" },
          company: { title: "Museum of Business", short: "Companies whose history is an exhibit already", judge: "rates whose companies have the oddest backstory" },
          club: { title: "Museum of Oddballs", short: "Clubs with histories you could not make up", judge: "rates whose clubs have the most absurd stories" },
          profession: { title: "Museum of Jobs", short: "Jobs nobody believes in until they see them", judge: "rates whose jobs are stranger: the rarest, most unbelievable ones" },
          invention: { title: "Hall of Gadgets", short: "Inventions that belong behind glass", judge: "rates whose inventions are odder: the strangest, most astonishing gadgets" },
        },
      },
      el: {
        title: "Μουσείο παραξενιών",
        short: "Μάζεψε πράγματα που θα έρθουν να χαζέψουν",
        judge: "κρίνει ποια εκθέματα είναι πιο παράξενα: σπάνια, αλλόκοτα, απίστευτα",
        byKind: {
          artist: { title: "Μουσείο μουσικής", short: "Ποιοι μπαίνουν σε μουσείο μουσικής", judge: "κρίνει ποιοι μουσικοί είναι πιο παράξενοι: τρελά λουκ, προκλήσεις, σκάνδαλα" },
          film: { title: "Μουσείο ταινιών", short: "Ταινίες που θέλουν προθήκη", judge: "κρίνει ποιες ταινίες είναι πιο τρελές: οι πιο παράξενες ιστορίες" },
          series: { title: "Αίθουσα σειρών", short: "Σειρές που τις κοιτάς σαν αξιοπερίεργα", judge: "κρίνει ποιες σειρές είναι πιο αλλόκοτες: οι πιο τρελές πλοκές" },
          person: { title: "Θάλαμος παραξενιών", short: "Άνθρωποι που όλοι έρχονται να χαζέψουν", judge: "κρίνει ποιοι άνθρωποι είναι πιο εκκεντρικοί: παράξενες ζωές και καμώματα" },
          character: { title: "Αίθουσα μυθοπλασίας", short: "Ήρωες που αξίζουν εισιτήριο", judge: "κρίνει ποιοι ήρωες είναι πιο αλλόκοτοι: παράξενη όψη και δυνάμεις" },
          food: { title: "Μουσείο φαγητού", short: "Πιάτα που τα κοιτάς με φρίκη και θαυμασμό", judge: "κρίνει ποια πιάτα έχουν την πιο παράξενη όψη και γεύση" },
          city: { title: "Μουσείο πόλεων", short: "Πόλεις που είναι εκθέματα από μόνες τους", judge: "κρίνει ποιες πόλεις είναι πιο ασυνήθιστες: δρόμοι, έθιμα, κτίρια" },
          country: { title: "Μουσείο χωρών", short: "Χώρες που είναι ήδη θάλαμος παραξενιών", judge: "κρίνει ποιες χώρες έχουν τα πιο παράξενα έθιμα και νόμους" },
          place: { title: "Αίθουσα θαυμάτων", short: "Μέρη που σου πέφτει το σαγόνι", judge: "κρίνει ποια μέρη είναι πιο αλλόκοτα: τα πιο εξωπραγματικά θεάματα" },
          animal: { title: "Θάλαμος σπάνιων", short: "Ζώα που δεν τα δείχνει κανένας άλλος", judge: "κρίνει ποια ζώα είναι τα πιο σπάνια και παράξενα" },
          painting: { title: "Αίθουσα τρελής τέχνης", short: "Πίνακες που μένεις μπροστά τους με ανοιχτό στόμα", judge: "κρίνει ποιοι πίνακες είναι πιο τρελοί και αινιγματικοί" },
          company: { title: "Μουσείο επιχειρήσεων", short: "Εταιρείες που η ιστορία τους είναι έκθεμα", judge: "κρίνει ποιες εταιρείες έχουν την πιο παράξενη ιστορία" },
          club: { title: "Μουσείο γκαφών", short: "Σύλλογοι με ιστορίες που δεν τις βγάζει μυαλό", judge: "κρίνει ποιοι σύλλογοι έχουν τις πιο απίθανες ιστορίες" },
          profession: { title: "Μουσείο επαγγελμάτων", short: "Δουλειές που δεν τις πιστεύεις αν δεν τις δεις", judge: "κρίνει ποια επαγγέλματα είναι τα πιο σπάνια και απίστευτα" },
          invention: { title: "Αίθουσα μαραφετιών", short: "Εφευρέσεις που θέλουν βιτρίνα", judge: "κρίνει ποιες εφευρέσεις είναι πιο παράξενες και εκπληκτικές" },
        },
      },
    },
  },
  {
    id: "timemachine",
    icon: "⏳",
    title: "Отправить в прошлое",
    short: "Собери посылку для Средневековья",
    // У изобретений базовая цель и так «набор, который берём в прошлое» — дубль.
    // На музыкантах задание не различает составы: ранжирование выходит тем же, что в обычном.
    notKinds: ["invention", "artist"],
    what: "груз для машины времени в Средневековье",
    criteria: "насколько перевернёт ход истории, шок для современников, последствия",
    prompt: "Оценивай размах последствий: что произведёт эффект разорвавшейся бомбы, а что средневековье просто не заметит.",
    judge: "оценивает, что сильнее поразит и изменит Средневековье",
    byKind: {
      film: { title: "Кино для рыцарей", short: "Что показать Средневековью на большом экране", judge: "оценивает, какие фильмы сильнее потрясут средневековых зрителей" },
      series: { title: "Сериал для инквизиции", short: "Что запустить в прошлом на всю деревню", judge: "оценивает, какие сериалы сильнее взбудоражат средневековую деревню" },
      person: { title: "Гости из будущего", short: "Кого забросить в Средние века", judge: "оценивает, чьи люди больше изменят историю своими знаниями" },
      character: { title: "Герои в прошлом", short: "Кого выпустить в Средневековье", judge: "оценивает, чьи герои своими способностями сильнее перевернут прошлое" },
      food: { title: "Ужин для короля", short: "Чем накормить средневековый двор", judge: "оценивает, какие блюда сильнее поразят короля и изменят кухню" },
      city: { title: "Город из будущего", short: "Какой город перенести на тысячу лет назад", judge: "оценивает, чьи города сильнее потрясут Средневековье: небоскрёбы, метро, технологии" },
      country: { title: "Страна в прошлом", short: "Целую страну — на тысячу лет назад", judge: "оценивает, чьи страны сильнее перепишут историю: технологии, законы, армия" },
      place: { title: "Чудо в прошлом", short: "Какое место перенести в Средневековье", judge: "оценивает, чьи места сильнее ошеломят средневековых людей" },
      animal: { title: "Зверь для прошлого", short: "Кого выпустить в средневековый лес", judge: "оценивает, какие звери сильнее изменят хозяйство и войны" },
      painting: { title: "Картина для монахов", short: "Что повесить в средневековом храме", judge: "оценивает, какие картины сильнее шокируют монахов и изменят искусство" },
      company: { title: "Фирма в Средневековье", short: "Какую фирму открыть в Средних веках", judge: "оценивает, чьи фирмы и товары сильнее изменят Средневековье" },
      club: { title: "Турнир для короля", short: "Кого выставить на турнир перед королём", judge: "оценивает, чьи клубы сильнее и зрелищнее на турнире перед королём" },
      profession: { title: "Спецы в прошлое", short: "Кого отправить учить Средневековье", judge: "оценивает, чьи спецы сильнее ускорят прогресс Средневековья" },
    },
    t: {
      en: {
        title: "Send to the Past",
        short: "Pack a parcel for the Middle Ages",
        judge: "rates what would stun and change the Middle Ages most",
        byKind: {
          film: { title: "Cinema for Knights", short: "What you screen for the Middle Ages", judge: "rates which films would stun a medieval audience most" },
          series: { title: "Binge for the Past", short: "What you put on for the whole village", judge: "rates which shows would stir up a medieval village most" },
          person: { title: "Guests from Ahead", short: "Who you drop into the Middle Ages", judge: "rates whose people would change history most with their knowledge" },
          character: { title: "Heroes in the Past", short: "Who you let loose in the Middle Ages", judge: "rates whose characters' powers would turn the past upside down" },
          food: { title: "Dinner for a King", short: "What you feed a medieval court", judge: "rates which dishes would wow the king and change cooking" },
          city: { title: "City from the Future", short: "Which city you drop a thousand years back", judge: "rates whose cities stun the Middle Ages: skyscrapers, subways, tech" },
          country: { title: "A Country Displaced", short: "A whole country, a thousand years back", judge: "rates whose countries rewrite history: technology, laws, armies" },
          place: { title: "Wonder in the Past", short: "Which landmark you move to the Middle Ages", judge: "rates whose places would amaze medieval people most" },
          animal: { title: "Beast for the Past", short: "What you set loose in a medieval forest", judge: "rates which animals would change farming and warfare most" },
          painting: { title: "Art for the Monks", short: "What you hang in a medieval church", judge: "rates which paintings would shock the monks and change art" },
          company: { title: "Medieval Startup", short: "Which company you open in the Middle Ages", judge: "rates whose companies and products would change medieval life most" },
          club: { title: "Tournament Squad", short: "Who you enter in a tournament before the king", judge: "rates whose clubs would dominate the king's tournament" },
          profession: { title: "Experts to the Past", short: "Who you send to teach the Middle Ages", judge: "rates whose experts would speed up medieval progress most" },
        },
      },
      el: {
        title: "Στείλε στο παρελθόν",
        short: "Φτιάξε ένα πακέτο για τον Μεσαίωνα",
        judge: "κρίνει τι θα συγκλόνιζε και θα άλλαζε περισσότερο τον Μεσαίωνα",
        byKind: {
          film: { title: "Σινεμά για ιππότες", short: "Τι θα προβάλεις στον Μεσαίωνα", judge: "κρίνει ποιες ταινίες θα συγκλόνιζαν περισσότερο το μεσαιωνικό κοινό" },
          series: { title: "Σειρά στον Μεσαίωνα", short: "Τι θα βάλεις να δει όλο το χωριό", judge: "κρίνει ποιες σειρές θα αναστάτωναν περισσότερο ένα μεσαιωνικό χωριό" },
          person: { title: "Επισκέπτες από αύριο", short: "Ποιους θα ρίξεις στον Μεσαίωνα", judge: "κρίνει ποιανού οι γνώσεις θα άλλαζαν περισσότερο την ιστορία" },
          character: { title: "Ήρωες στον Μεσαίωνα", short: "Ποιους θα αφήσεις λυτούς στον Μεσαίωνα", judge: "κρίνει ποιανού οι δυνάμεις θα ανέτρεπαν το παρελθόν" },
          food: { title: "Δείπνο για βασιλιά", short: "Τι θα σερβίρεις σε μεσαιωνική αυλή", judge: "κρίνει ποια πιάτα θα μάγευαν τον βασιλιά και την αυλή" },
          city: { title: "Πόλη από το μέλλον", short: "Ποια πόλη θα στείλεις χίλια χρόνια πίσω", judge: "κρίνει ποιες πόλεις θα σόκαραν τον Μεσαίωνα: ουρανοξύστες, μετρό, τεχνολογία" },
          country: { title: "Χώρα στο παρελθόν", short: "Μια ολόκληρη χώρα, χίλια χρόνια πίσω", judge: "κρίνει ποιες χώρες θα ξανάγραφαν την ιστορία: τεχνολογία, νόμοι, στρατός" },
          place: { title: "Θαύμα στο παρελθόν", short: "Ποιο αξιοθέατο θα πάει στον Μεσαίωνα", judge: "κρίνει ποια μέρη θα θάμπωναν περισσότερο τους ανθρώπους του Μεσαίωνα" },
          animal: { title: "Θηρίο στο παρελθόν", short: "Τι θα αφήσεις λυτό στο μεσαιωνικό δάσος", judge: "κρίνει ποια ζώα θα άλλαζαν περισσότερο γεωργία και πόλεμο" },
          painting: { title: "Τέχνη για μοναχούς", short: "Τι θα κρεμάσεις σε μεσαιωνικό ναό", judge: "κρίνει ποιοι πίνακες θα σόκαραν περισσότερο τους μοναχούς" },
          company: { title: "Μπίζνα στον Μεσαίωνα", short: "Ποια εταιρεία θα ανοίξεις στον Μεσαίωνα", judge: "κρίνει ποιες εταιρείες θα άλλαζαν περισσότερο τη ζωή στον Μεσαίωνα" },
          club: { title: "Τουρνουά για βασιλιά", short: "Ποιον θα βάλεις σε τουρνουά μπροστά στον βασιλιά", judge: "κρίνει ποιοι σύλλογοι θα κυριαρχούσαν στο τουρνουά του βασιλιά" },
          profession: { title: "Ειδικοί στο παρελθόν", short: "Ποιους θα στείλεις να μάθουν στον Μεσαίωνα", judge: "κρίνει ποιοι ειδικοί θα επιτάχυναν περισσότερο την πρόοδο" },
        },
      },
    },
  },
  {
    id: "gift",
    icon: "🎁",
    title: "Подарок врагу",
    short: "Собери подарок, от которого врагу станет грустно",
    what: "издевательский подарочный набор для недруга",
    criteria: "неловкость, бесполезность, способность испортить настроение, но без жестокости",
    prompt: "Оценивай изящество издёвки: подарок должен быть формально приличным, но обидно бесполезным. Прямая грубость — минус.",
    judge: "оценивает, чей подарок противнее: бесит, но без жестокости",
    byKind: {
      artist: { title: "Плейлист для врага", short: "Музыка, от которой враг завоет", judge: "оценивает, чью музыку невыносимее слушать часами" },
      film: { title: "Киновечер для врага", short: "Что заставить врага смотреть до конца", judge: "оценивает, какие фильмы мучительнее досмотреть до конца" },
      series: { title: "Сериал для врага", short: "Что подсунуть врагу на все выходные", judge: "оценивает, чьи сериалы скучнее и длиннее: сотни серий тоски" },
      person: { title: "Гости для врага", short: "Кого подселить врагу на неделю", judge: "оценивает, с какими гостями неделя выйдет самой невыносимой" },
      character: { title: "Соседи для врага", short: "Кого поселить врагу за стенкой", judge: "оценивает, какие соседи бесят сильнее: шумные, назойливые, но безвредные" },
      food: { title: "Ужин для врага", short: "Чем угостить врага, чтобы он загрустил", judge: "оценивает, чей ужин обиднее: невкусно, странно, но съедобно" },
      city: { title: "Путёвка врагу", short: "Куда отправить врага отдыхать", judge: "оценивает, чья путёвка тоскливее: скука, неудобства, плохая погода" },
      country: { title: "Билет в один конец", short: "В какую страну сослать врага", judge: "оценивает, где ссылка тоскливее: скучно, неудобно, но безопасно" },
      place: { title: "Экскурсия врагу", short: "Куда сводить врага на целый день", judge: "оценивает, какая экскурсия скучнее и утомительнее" },
      animal: { title: "Питомец для врага", short: "Кого подарить врагу в маленькую квартиру", judge: "оценивает, с чьими питомцами больше хлопот: шум, грязь, размер" },
      painting: { title: "Картина врагу", short: "Что повесить врагу над диваном", judge: "оценивает, какую картину стыдно повесить, но жалко выбросить" },
      company: { title: "Акции для врага", short: "Чьи акции подарить врагу на память", judge: "оценивает, чьи акции быстрее обесценятся" },
      club: { title: "Клуб для врага", short: "За кого заставить врага болеть", judge: "оценивает, за чьи клубы болеть больнее: вечные поражения и позор" },
      profession: { title: "Работа для врага", short: "Кем враг будет работать до пенсии", judge: "оценивает, какая работа скучнее и бессмысленнее" },
      invention: { title: "Гаджет для врага", short: "Какую штуковину вручить врагу с бантиком", judge: "оценивает, какие штуковины бесполезнее и нелепее" },
    },
    t: {
      en: {
        title: "Gift for an Enemy",
        short: "Wrap up something your enemy will politely hate",
        judge: "rates whose gift is nastier: annoying, but never cruel",
        byKind: {
          artist: { title: "Playlist for a Foe", short: "Music that makes your enemy howl", judge: "rates whose music is hardest to sit through for hours" },
          film: { title: "Movie Night Revenge", short: "What your enemy has to sit through", judge: "rates which films are most painful to sit through" },
          series: { title: "Series for a Foe", short: "What to hand your enemy for the weekend", judge: "rates whose shows are dullest and longest: endless boring seasons" },
          person: { title: "Houseguests", short: "Who moves in with your enemy for a week", judge: "rates which guests make the longest, most unbearable week" },
          character: { title: "Neighbours", short: "Who moves in next door to your enemy", judge: "rates which neighbours annoy most: loud, pushy, but harmless" },
          food: { title: "Dinner for a Foe", short: "What to serve your enemy to ruin the day", judge: "rates whose dinner stings most: nasty, weird, but edible" },
          city: { title: "Holiday Booked", short: "Where you send your enemy on holiday", judge: "rates whose holiday is drearier: boredom, hassle, bad weather" },
          country: { title: "One-Way Ticket", short: "Which country you exile your enemy to", judge: "rates where exile is drearier: dull, awkward, but safe" },
          place: { title: "Day Trip Revenge", short: "Where your enemy spends the whole day", judge: "rates which trip is the dullest and most tiring" },
          animal: { title: "Pet for a Foe", short: "What you gift into their tiny flat", judge: "rates whose pets are more hassle: noise, mess, sheer size" },
          painting: { title: "Art for a Foe", short: "What goes up above their sofa", judge: "rates which art is embarrassing to hang, impossible to bin" },
          company: { title: "Shares for a Foe", short: "Whose shares you gift as a keepsake", judge: "rates whose shares lose value fastest" },
          club: { title: "Club for a Foe", short: "Who your enemy has to support now", judge: "rates which clubs hurt most to support: endless defeats, shame" },
          profession: { title: "Job for a Foe", short: "What your enemy does for a living now", judge: "rates which job is the dullest and most pointless" },
          invention: { title: "Gadget for a Foe", short: "What you hand them with a bow on top", judge: "rates which gadgets are the most useless and ridiculous" },
        },
      },
      el: {
        title: "Δώρο στον εχθρό",
        short: "Φτιάξε ένα δώρο που θα το μισήσει ευγενικά",
        judge: "κρίνει ποιο δώρο είναι πιο εκνευριστικό, αλλά όχι σκληρό",
        byKind: {
          artist: { title: "Πλεϊλίστ για εχθρό", short: "Μουσική που θα τον κάνει να ουρλιάξει", judge: "κρίνει ποια μουσική είναι πιο αβάσταχτη για ώρες" },
          film: { title: "Σινεμά-εκδίκηση", short: "Τι θα αναγκαστεί να δει μέχρι τέλους", judge: "κρίνει ποιες ταινίες είναι πιο βασανιστικές μέχρι το τέλος" },
          series: { title: "Σειρά για εχθρό", short: "Τι θα του δώσεις για όλο το σαββατοκύριακο", judge: "κρίνει ποιες σειρές είναι πιο βαρετές και ατελείωτες" },
          person: { title: "Καλεσμένοι-τιμωρία", short: "Ποιους θα του βάλεις σπίτι για μια βδομάδα", judge: "κρίνει με ποιους καλεσμένους η βδομάδα γίνεται πιο αβάσταχτη" },
          character: { title: "Γείτονες-τιμωρία", short: "Ποιους θα του βάλεις τοίχο με τοίχο", judge: "κρίνει ποιοι γείτονες εκνευρίζουν πιο πολύ: θορυβώδεις, αδιάκριτοι, αλλά ακίνδυνοι" },
          food: { title: "Δείπνο για εχθρό", short: "Τι θα του σερβίρεις για να του χαλάσεις τη μέρα", judge: "κρίνει ποιο δείπνο είναι πιο προσβλητικό: άνοστο, παράξενο, αλλά φαγώσιμο" },
          city: { title: "Εισιτήριο-δώρο", short: "Πού θα τον στείλεις διακοπές", judge: "κρίνει ποιο ταξίδι είναι πιο μίζερο: βαρεμάρα, ταλαιπωρία, κακοκαιρία" },
          country: { title: "Χωρίς επιστροφή", short: "Σε ποια χώρα θα τον εξορίσεις", judge: "κρίνει ποια εξορία είναι πιο μίζερη: βαρετή, άβολη, αλλά ασφαλής" },
          place: { title: "Εκδρομή-τιμωρία", short: "Πού θα περάσει όλη του τη μέρα", judge: "κρίνει ποια εκδρομή είναι πιο βαρετή και κουραστική" },
          animal: { title: "Κατοικίδιο-εκδίκηση", short: "Τι θα του χαρίσεις στο μικρό του σπίτι", judge: "κρίνει ποια κατοικίδια έχουν τον περισσότερο μπελά: θόρυβο, βρωμιά, μέγεθος" },
          painting: { title: "Πίνακας για εχθρό", short: "Τι θα κρεμάσει πάνω από τον καναπέ", judge: "κρίνει ποιον πίνακα ντρέπεσαι να κρεμάσεις, αλλά λυπάσαι να πετάξεις" },
          company: { title: "Μετοχές για εχθρό", short: "Ποιες μετοχές θα του χαρίσεις για ενθύμιο", judge: "κρίνει ποιες μετοχές χάνουν αξία πιο γρήγορα" },
          club: { title: "Ομάδα για εχθρό", short: "Ποια ομάδα θα αναγκαστεί να υποστηρίζει", judge: "κρίνει ποια ομάδα πονάει πιο πολύ: ατελείωτες ήττες και ντροπή" },
          profession: { title: "Δουλειά για εχθρό", short: "Τι δουλειά θα κάνει από δω και πέρα", judge: "κρίνει ποια δουλειά είναι πιο βαρετή και άσκοπη" },
          invention: { title: "Μαραφέτι-δώρο", short: "Τι θα του δώσεις με φιόγκο από πάνω", judge: "κρίνει ποια μαραφέτια είναι πιο άχρηστα και γελοία" },
        },
      },
    },
  },
];

const BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));
// `kinds` — белый список (задание живёт только там), `notKinds` — чёрный (везде, кроме).
// Чёрный удобнее, когда задание почти везде уместно и надо выкинуть две-три категории.
const modesForKind = (kind) =>
  MODES.filter((m) => (!m.kinds || m.kinds.includes(kind)) && !(m.notKinds && m.notKinds.includes(kind)));
const modeById = (id) => BY_ID[id] || BY_ID.base;

/*
 * Текст задания для конкретной категории и языка.
 * Слои накладываются снизу вверх: общий русский → русский byKind → перевод → перевод byKind.
 * Русский лежит в корне задания, переводы — в `t.<lang>` с той же структурой (title/short/judge/byKind).
 * Непереведённое место автоматически показывается по-русски, а не пустым: игра должна работать
 * и с наполовину готовым переводом.
 * Промптовые поля (what/criteria/prompt/kinds/notKinds) сюда не попадают — они общие и уходят
 * в промпт судьи, который остаётся русским.
 */
const TEXT_FIELDS = ["icon", "title", "short", "judge"];
const modeText = (id, kind, lang) => {
  const m = modeById(id);
  const out = {};
  for (const f of TEXT_FIELDS) out[f] = m[f];
  const put = (src) => { if (src) for (const f of TEXT_FIELDS) if (src[f]) out[f] = src[f]; };
  put(m.byKind && m.byKind[kind]);
  const tr = m.t && m.t[lang];
  put(tr);
  put(tr && tr.byKind && tr.byKind[kind]);
  // {items} — чем торгуют в этой категории: «набор {items}» → «набор блюд»
  const items = itemsFor(kind, lang);
  for (const f of TEXT_FIELDS) if (typeof out[f] === "string") out[f] = out[f].split("{items}").join(items);
  out.id = m.id;
  return out;
};

if (typeof module !== "undefined" && module.exports) module.exports = { MODES, modeById, modeText, modesForKind };
if (typeof window !== "undefined") { window.AUCTION_MODES = MODES; window.auctionModeById = modeById; window.auctionModeText = modeText; window.auctionModesForKind = modesForKind; }
