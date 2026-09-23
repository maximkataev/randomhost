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
 * `judge` — правило победы («решает, чья банда и правда захватит мир»), а не перечень
 * критериев: критерии живут в `criteria`/`prompt` и уходят в промпт судьи, игрок их не читает.
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
    judge: "ищет самый сильный и цельный набор",
    byKind: {
      artist: { title: "Лайнап фестиваля", short: "Собери фестиваль, на который пойдут", judge: "смотрит на хедлайнеров и сочетаемость состава" },
      film: { title: "Киномарафон", short: "Вечер, который смотрят не отрываясь", judge: "оценивает, как фильмы смотрятся подряд" },
      series: { title: "Сезон сериалов", short: "Подписка, от которой не оторваться", judge: "смотрит, затягивает ли подборка и держит ли баланс жанров" },
      person: { title: "Ужин мечты", short: "Собери гостей, с которыми не заскучаешь", judge: "оценивает, какой выйдет вечер за одним столом" },
      character: { title: "Отряд героев", short: "Команда, которая выигрывает замес", judge: "считает, чей отряд победит в схватке" },
      food: { title: "Меню ужина", short: "Собери ужин, который работает целиком", judge: "смотрит, работает ли это как один ужин" },
      city: { title: "Маршрут мечты", short: "Поездка, которую захочется повторить", judge: "смотрит, интересно ли и реально ли это проехать" },
      country: { title: "Кругосветка", short: "Собери маршрут вокруг света", judge: "смотрит, интересно ли и реально ли это проехать" },
      place: { title: "Тур по чудесам", short: "Места, ради которых стоит лететь", judge: "смотрит, стоит ли ради этого лететь" },
      animal: { title: "Зоопарк мечты", short: "Собери тех, на кого пойдут смотреть", judge: "смотрит, на кого пойдут смотреть" },
      painting: { title: "Частная галерея", short: "Коллекция, которой можно хвастаться", judge: "оценивает ценность и цельность коллекции" },
      company: { title: "Инвестпортфель", short: "Собери портфель, который вырастет", judge: "смотрит, во что здесь стоит вкладываться" },
      club: { title: "Спортивная империя", short: "Клубы, которые берут титулы", judge: "считает титулы, аудиторию и стоимость клубов" },
      profession: { title: "Экипаж для острова", short: "Кто вытащит вас с необитаемого острова", judge: "считает, выживет ли такой экипаж" },
      invention: { title: "Груз в прошлое", short: "Изобретения, которые перепишут историю", judge: "измеряет, насколько набор изменит историю" },
    },
    t: {
      en: {
        title: "Best Set",
        short: "The classic: assemble the strongest set you can",
        judge: "looks for the strongest, most coherent set",
        byKind: {
          artist: { title: "Festival Line-up", short: "Build a festival people would show up to", judge: "checks the headliners and how well the line-up fits together" },
          film: { title: "Movie Marathon", short: "A night nobody wants to pause", judge: "judges how the films play back to back" },
          series: { title: "Binge Season", short: "A subscription you cannot quit", judge: "checks whether the picks hook you and keep the genres balanced" },
          person: { title: "Dream Dinner", short: "Invite guests who keep the night alive", judge: "judges how the evening would go with all of them at one table" },
          character: { title: "Hero Squad", short: "A team that wins the brawl", judge: "works out whose squad wins the fight" },
          food: { title: "Dinner Menu", short: "Build a dinner that works as a whole", judge: "looks at whether it works as one dinner" },
          city: { title: "Dream Trip", short: "A trip you would book all over again", judge: "looks at the experiences and whether the route actually works" },
          country: { title: "Round the World", short: "Plot a route all the way around the globe", judge: "looks at the experiences and whether the route actually works" },
          place: { title: "Wonders Tour", short: "Places worth getting on a plane for", judge: "looks at whether it is worth the flight" },
          animal: { title: "Dream Zoo", short: "Gather the animals people queue up for", judge: "looks at who people would come to see" },
          painting: { title: "Private Gallery", short: "A collection worth bragging about", judge: "judges the value and the coherence of the collection" },
          company: { title: "Investment Portfolio", short: "Build a portfolio that only goes up", judge: "looks at whether this is worth investing in" },
          club: { title: "Sports Empire", short: "Clubs that actually lift trophies", judge: "counts the trophies, the fanbase and the value of the clubs" },
          profession: { title: "Island Crew", short: "Who gets you off a desert island", judge: "works out whether a crew like that survives" },
          invention: { title: "Cargo to the Past", short: "Inventions that rewrite history", judge: "measures how much the set would change history" },
        },
      },
      el: {
        title: "Καλύτερο σετ",
        short: "Το κλασικό: φτιάξε το πιο δυνατό σετ",
        judge: "ψάχνει το πιο δυνατό και συνεπές σετ",
        byKind: {
          artist: { title: "Λάιναπ φεστιβάλ", short: "Φτιάξε ένα φεστιβάλ που θα πάει ο κόσμος", judge: "κοιτάζει τα headliners και πόσο δένει το λάιναπ" },
          film: { title: "Μαραθώνιος ταινιών", short: "Μια βραδιά που δεν πατάς pause", judge: "κρίνει πώς δένουν οι ταινίες η μία μετά την άλλη" },
          series: { title: "Σεζόν σειρών", short: "Μια συνδρομή που δεν την κλείνεις με τίποτα", judge: "βλέπει αν σε κολλάει η επιλογή και αν ισορροπεί τα είδη" },
          person: { title: "Δείπνο των ονείρων", short: "Μάζεψε καλεσμένους που δεν τους βαριέσαι", judge: "κρίνει τι βραδιά θα βγει με όλους στο ίδιο τραπέζι" },
          character: { title: "Ομάδα ηρώων", short: "Μια ομάδα που κερδίζει τη μάχη", judge: "υπολογίζει ποια ομάδα νικά στη σύγκρουση" },
          food: { title: "Μενού δείπνου", short: "Φτιάξε ένα δείπνο που στέκει ολόκληρο", judge: "κοιτάζει αν στέκει σαν ένα δείπνο" },
          city: { title: "Ταξίδι των ονείρων", short: "Ένα ταξίδι που θα θες να το ξανακάνεις", judge: "κοιτάζει τις εμπειρίες και το αν βγαίνει η διαδρομή" },
          country: { title: "Γύρος του κόσμου", short: "Φτιάξε μια διαδρομή γύρω από τον κόσμο", judge: "κοιτάζει τις εμπειρίες και το αν βγαίνει η διαδρομή" },
          place: { title: "Τουρ στα θαύματα", short: "Μέρη που αξίζουν το αεροπλάνο", judge: "κοιτάζει αν αξίζει το ταξίδι" },
          animal: { title: "Ιδανικός ζωολογικός", short: "Μάζεψε ζώα που αξίζουν την ουρά στο ταμείο", judge: "κοιτάζει ποιους θα έρθουν να δουν" },
          painting: { title: "Ιδιωτική γκαλερί", short: "Μια συλλογή για να καμαρώνεις", judge: "κρίνει την αξία και τη συνοχή της συλλογής" },
          company: { title: "Χαρτοφυλάκιο", short: "Φτιάξε ένα χαρτοφυλάκιο που ανεβαίνει", judge: "κοιτάζει αν αξίζει να επενδύσεις εδώ" },
          club: { title: "Αθλητική αυτοκρατορία", short: "Σύλλογοι που σηκώνουν τρόπαια", judge: "μετράει τρόπαια, κοινό και αξία των συλλόγων" },
          profession: { title: "Πλήρωμα για το νησί", short: "Ποιοι θα σε βγάλουν από το έρημο νησί", judge: "υπολογίζει αν επιβιώνει ένα τέτοιο πλήρωμα" },
          invention: { title: "Φορτίο στο παρελθόν", short: "Εφευρέσεις που ξαναγράφουν την ιστορία", judge: "μετράει πόσο θα άλλαζε την ιστορία το σετ" },
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
    judge: "ищет, у кого сочетается хуже всех",
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
        judge: "looks for whose picks clash the most",
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
        judge: "ψάχνει ποιανού τα διαλεγμένα ταιριάζουν χειρότερα",
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
    judge: "решает, чья банда и правда захватит мир",
    byKind: {
      artist: { title: "Банда со сцены", short: "Музыканты, из которых вышли бы отличные злодеи", judge: "решает, из чьей компании злодеи вышли бы убедительнее" },
      person: { title: "Совет злодеев", short: "Знаменитости, которые поделят мир между собой", judge: "решает, чей совет и правда захватил бы мир" },
      character: { title: "Лига суперзлодеев", short: "Злодеи, против которых у героев нет шансов", judge: "решает, чья лига раскатает всех героев" },
      animal: { title: "Звериная орда", short: "Звери, от которых человечеству не отбиться", judge: "решает, чья стая опаснее" },
      club: { title: "Клубы-злодеи", short: "Клубы, которые заберут весь спорт себе", judge: "решает, чьи клубы подмяли спорт целиком" },
      company: { title: "Корпорация зла", short: "Корпорации, которые тайно правят миром", judge: "решает, чья корпорация опаснее для мира" },
      profession: { title: "Штат суперзлодея", short: "Спецы, без которых логово не работает", judge: "решает, чей штат провернёт захват мира" },
    },
    t: {
      en: {
        title: "Supervillain League",
        short: "Assemble the crew that takes over the world",
        judge: "decides whose crew could actually pull off world domination",
        byKind: {
          artist: { title: "Band Gone Bad", short: "Musicians who would make excellent villains", judge: "decides whose line-up makes the more convincing villains" },
          person: { title: "Council of Villains", short: "Celebrities who carve up the world between them", judge: "decides whose council could really pull it off" },
          character: { title: "Supervillain League", short: "Villains the heroes cannot possibly beat", judge: "decides whose league flattens every hero" },
          animal: { title: "Beast Horde", short: "Animals humanity could not fight off", judge: "decides whose pack is the more dangerous" },
          club: { title: "Villain Clubs", short: "Clubs that would take the whole sport over", judge: "decides whose clubs took the sport over" },
          company: { title: "Evil Corporation", short: "Corporations that secretly run the world", judge: "decides whose corporation is the more dangerous" },
          profession: { title: "Evil Lair Staff", short: "The specialists every evil lair needs", judge: "decides whose staff pulls the takeover off" },
        },
      },
      el: {
        title: "Λίγκα σούπερ κακών",
        short: "Μάζεψε αυτούς που θα κατακτήσουν τον κόσμο",
        judge: "κρίνει ποια συμμορία θα κατακτήσει όντως τον κόσμο",
        byKind: {
          artist: { title: "Μπάντα κακοποιών", short: "Μουσικοί που θα έκαναν εξαιρετικούς κακούς", judge: "κρίνει ποιο λάιναπ βγάζει πιο πειστικούς κακούς" },
          person: { title: "Συμβούλιο κακών", short: "Διάσημοι που θα μοιράσουν τον κόσμο μεταξύ τους", judge: "κρίνει ποιο συμβούλιο θα τα κατάφερνε όντως" },
          character: { title: "Λίγκα σούπερ κακών", short: "Κακοί που οι ήρωες δεν τους βγάζουν με τίποτα", judge: "κρίνει ποια λίγκα διαλύει όλους τους ήρωες" },
          animal: { title: "Ορδή των ζώων", short: "Ζώα που η ανθρωπότητα δεν θα σταματούσε", judge: "κρίνει ποια αγέλη είναι πιο επικίνδυνη" },
          club: { title: "Σύλλογοι κακών", short: "Σύλλογοι που θα πάρουν όλο το άθλημα δικό τους", judge: "κρίνει ποιοι σύλλογοι πήραν το άθλημα δικό τους" },
          company: { title: "Εταιρεία του κακού", short: "Εταιρείες που κυβερνούν κρυφά τον κόσμο", judge: "κρίνει ποια εταιρεία είναι πιο επικίνδυνη" },
          profession: { title: "Προσωπικό του κακού", short: "Οι ειδικοί που θέλει κάθε κρησφύγετο κακού", judge: "κρίνει ποιο προσωπικό βγάζει την κατάκτηση" },
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
    judge: "считает, кто продержится дольше после конца света",
    byKind: {
      person: { title: "Бункер знаменитостей", short: "Кого берёшь в бункер, когда всё рухнуло", judge: "считает, чей бункер продержится дольше" },
      character: { title: "Отряд выживших", short: "Кто вытащит тебя из конца света", judge: "считает, чей отряд доживёт до финала" },
      food: { title: "Запас на бункер", short: "Чем питаться, когда магазинов больше нет", judge: "считает, чьи запасы кончатся последними" },
      city: { title: "Где пересидеть", short: "Города, в которых есть шанс дожить до весны", judge: "считает, где реально можно переждать" },
      country: { title: "Куда бежать", short: "Страны, в которых пересидишь конец света", judge: "считает, какая страна и правда спасёт" },
      place: { title: "Последнее убежище", short: "Где забаррикадироваться, когда всё рухнуло", judge: "считает, какое убежище выдержит дольше" },
      animal: { title: "Звери-напарники", short: "Кто прокормит и защитит после конца света", judge: "считает, чья живность реально спасёт" },
      company: { title: "Корпорации-бункеры", short: "Чьи склады и заводы спасут после краха", judge: "считает, чей холдинг переживёт крах цивилизации" },
      club: { title: "Кланы со стадионов", short: "Стадион как крепость, фанаты как армия", judge: "считает, чей клан удержит район после краха" },
      invention: { title: "Что взять в бункер", short: "Изобретения, без которых не выжить", judge: "считает, что спасёт, а что окажется балластом" },
    },
    t: {
      en: {
        title: "Apocalypse Survival",
        short: "Gather what gets you through the end of the world",
        judge: "works out who lasts longest after the end of the world",
        byKind: {
          person: { title: "Celebrity Bunker", short: "Who you take into the bunker when it all falls apart", judge: "works out whose bunker holds out longest" },
          character: { title: "Survivor Squad", short: "Who drags you out of the apocalypse", judge: "works out whose squad makes it to the end" },
          food: { title: "Bunker Supplies", short: "What you eat once the shops are gone", judge: "works out whose supplies run out last" },
          city: { title: "Where to Sit It Out", short: "Cities where you might live to see the spring", judge: "works out where you could actually sit it out" },
          country: { title: "Where to Run", short: "Countries you could sit the apocalypse out in", judge: "works out which country actually saves you" },
          place: { title: "Last Refuge", short: "Where to barricade yourself when it all falls apart", judge: "works out which refuge holds out longest" },
          animal: { title: "Survival Partners", short: "Who feeds you and guards you after the collapse", judge: "works out whose animals actually save you" },
          company: { title: "Bunker Corporations", short: "Whose warehouses and factories save you after the crash", judge: "works out whose group outlives civilisation" },
          club: { title: "Stadium Clans", short: "The stadium is the fortress, the fans are the army", judge: "works out whose clan holds the district after the crash" },
          invention: { title: "Bunker Cargo", short: "The inventions you cannot survive without", judge: "works out what saves you and what is dead weight" },
        },
      },
      el: {
        title: "Μετά την αποκάλυψη",
        short: "Μάζεψε ό,τι θα σε βγάλει από το τέλος του κόσμου",
        judge: "υπολογίζει ποιος κρατάει περισσότερο μετά το τέλος του κόσμου",
        byKind: {
          person: { title: "Καταφύγιο διάσημων", short: "Ποιους παίρνεις στο καταφύγιο όταν όλα καταρρέουν", judge: "υπολογίζει ποιανού το καταφύγιο κρατάει περισσότερο" },
          character: { title: "Ομάδα επιβίωσης", short: "Ποιοι θα σε βγάλουν από την αποκάλυψη", judge: "υπολογίζει ποια ομάδα φτάνει ως το τέλος" },
          food: { title: "Προμήθειες καταφυγίου", short: "Τι θα τρως όταν δεν υπάρχουν μαγαζιά", judge: "υπολογίζει ποιανού οι προμήθειες τελειώνουν τελευταίες" },
          city: { title: "Πού θα κρυφτείς", short: "Πόλεις όπου έχεις ελπίδα να δεις άνοιξη", judge: "υπολογίζει πού μπορείς όντως να την βγάλεις" },
          country: { title: "Πού να το σκάσεις", short: "Χώρες όπου βγάζεις το τέλος του κόσμου", judge: "υπολογίζει ποια χώρα σε σώζει όντως" },
          place: { title: "Τελευταίο καταφύγιο", short: "Πού θα ταμπουρωθείς όταν όλα καταρρέουν", judge: "υπολογίζει ποιο καταφύγιο κρατάει περισσότερο" },
          animal: { title: "Σύντροφοι επιβίωσης", short: "Ποιοι θα σε θρέψουν και θα σε φυλάξουν", judge: "υπολογίζει ποια ζώα σε σώζουν στα αλήθεια" },
          company: { title: "Εταιρείες-καταφύγια", short: "Ποιανού οι αποθήκες και τα εργοστάσια σώζουν", judge: "υπολογίζει ποιος όμιλος επιβιώνει της κατάρρευσης" },
          club: { title: "Κλαν των γηπέδων", short: "Το γήπεδο κάστρο, οι οπαδοί στρατός", judge: "υπολογίζει ποιο κλαν κρατάει τη γειτονιά" },
          invention: { title: "Φορτίο καταφυγίου", short: "Εφευρέσεις χωρίς τις οποίες δεν επιβιώνεις", judge: "υπολογίζει τι σώζει και τι είναι άχρηστο βάρος" },
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
    judge: "выбирает вечеринку, о которой будут вспоминать год",
    // invention намеренно без своей строки title: общая «Вечеринка года» подходит гаджетам
    // как есть, а тест на запасной текст держится именно за эту пару.
    byKind: {
      artist: { title: "Музыка на вечеринке", short: "Кто выступает у тебя до самого утра", judge: "выбирает, у кого танцевали до рассвета" },
      film: { title: "Кино на вечеринке", short: "Что крутить на экране, когда все пришли", judge: "выбирает, у кого в зале никто не заскучал" },
      series: { title: "Марафон до утра", short: "Что включить, чтобы никто не ушёл спать", judge: "выбирает, чей марафон дотянул до рассвета" },
      person: { title: "Список гостей", short: "Кого позвать, чтобы вечер запомнили", judge: "выбирает, у кого гости устроили лучший вечер" },
      character: { title: "Гости из вымысла", short: "Позови героев, которые разнесут вечеринку", judge: "выбирает, чья вечеринка вышла легендарной" },
      food: { title: "Стол для вечеринки", short: "Еда, которую сметут до полуночи", judge: "выбирает, чей стол сделал вечер" },
      city: { title: "Где гуляем", short: "Города, в которых ночь не кончается", judge: "выбирает, где ночь вышла безумнее" },
      country: { title: "Тур по вечеринкам", short: "Страны, в которых не спят по ночам", judge: "выбирает, чей маршрут веселее" },
      place: { title: "Где закатить рейв", short: "Выбери, где танцевать там, где нельзя", judge: "выбирает, у кого место наглее и веселее" },
      animal: { title: "Звери на вечеринке", short: "Гости с лапами, копытами и клыками", judge: "выбирает, у кого зверинец веселее" },
      painting: { title: "Картины на стенах", short: "Чем завесить стены, чтобы все залипли", judge: "выбирает, чьи стены сделали атмосферу" },
      company: { title: "Кто платит за вечер", short: "Спонсоры, которые оплатят весь банкет", judge: "выбирает, чья корпоративка вышла легендарной" },
      club: { title: "После матча", short: "С чьими фанатами гулять после матча", judge: "выбирает, у кого празднование веселее" },
      profession: { title: "Команда праздника", short: "Спецы, которые вытянут любой праздник", judge: "выбирает, чья команда устроила лучший вечер" },
      invention: { title: "Гаджеты для вечера", short: "Гаджеты, без которых вечеринка не та", judge: "выбирает, чьи штуковины сделали вечер" },
    },
    t: {
      en: {
        title: "Party of the Year",
        short: "Throw a party nobody wants to leave",
        judge: "picks the party people will still be talking about next year",
        byKind: {
          artist: { title: "Who's Playing", short: "Who is on stage at your place till sunrise", judge: "picks whose crowd danced until dawn" },
          film: { title: "Party Screening", short: "What goes on the screen once everyone is in", judge: "picks whose room nobody got bored in" },
          series: { title: "All-Nighter Binge", short: "What keeps everybody from going to bed", judge: "picks whose marathon made it to sunrise" },
          person: { title: "The Guest List", short: "Who to invite so the night gets remembered", judge: "picks whose guests threw the better night" },
          character: { title: "Fictional Guests", short: "Invite the characters who wreck the place", judge: "picks whose party turned legendary" },
          food: { title: "Party Spread", short: "Food that is gone before midnight", judge: "picks whose table made the night" },
          city: { title: "Where We Go Out", short: "Cities where the night never ends", judge: "picks where the night got wilder" },
          country: { title: "Party World Tour", short: "Countries that simply do not sleep", judge: "picks whose route is more fun" },
          place: { title: "Where to Rave", short: "Pick the spot where dancing is not allowed", judge: "picks whose venue is the cheekiest" },
          animal: { title: "Animals Invited", short: "Guests with paws, hooves and fangs", judge: "picks whose menagerie is more fun" },
          painting: { title: "Art on the Walls", short: "What goes on the walls to hypnotise everyone", judge: "picks whose walls set the mood" },
          company: { title: "Who Pays for It", short: "Sponsors who pick up the whole tab", judge: "picks whose company party turned legendary" },
          club: { title: "Afterparty Crew", short: "Whose fans you celebrate with after the match", judge: "picks whose celebration is more fun" },
          profession: { title: "The Party Crew", short: "The pros who can save any party", judge: "picks whose crew threw the better night" },
          invention: { title: "Party Gadgets", short: "The gadgets a party is nothing without", judge: "picks whose gadgets made the night" },
        },
      },
      el: {
        title: "Πάρτι της χρονιάς",
        short: "Φτιάξε ένα πάρτι που δεν φεύγει κανείς",
        judge: "διαλέγει το πάρτι που θα το θυμούνται έναν χρόνο",
        byKind: {
          artist: { title: "Ποιοι παίζουν", short: "Ποιοι παίζουν στο πάρτι σου μέχρι το πρωί", judge: "διαλέγει πού χόρευαν μέχρι να ξημερώσει" },
          film: { title: "Προβολή στο πάρτι", short: "Τι παίζει στην οθόνη μόλις μαζευτούν όλοι", judge: "διαλέγει πού δεν βαρέθηκε κανείς" },
          series: { title: "Μαραθώνιος ως το πρωί", short: "Τι θα βάλεις για να μη πάει κανείς για ύπνο", judge: "διαλέγει ποιος μαραθώνιος έφτασε ως το ξημέρωμα" },
          person: { title: "Λίστα καλεσμένων", short: "Ποιους καλείς για να μείνει η βραδιά στην ιστορία", judge: "διαλέγει ποιανού οι καλεσμένοι έστησαν την καλύτερη βραδιά" },
          character: { title: "Ήρωες στο πάρτι", short: "Κάλεσε ήρωες που θα διαλύσουν το σπίτι", judge: "διαλέγει ποιανού το πάρτι έγινε θρύλος" },
          food: { title: "Μπουφές πάρτι", short: "Φαγητό που εξαφανίζεται πριν τα μεσάνυχτα", judge: "διαλέγει ποιανού το τραπέζι έκανε τη βραδιά" },
          city: { title: "Πού βγαίνουμε", short: "Πόλεις όπου η νύχτα δεν τελειώνει ποτέ", judge: "διαλέγει πού η νύχτα βγήκε πιο τρελή" },
          country: { title: "Παγκόσμιο πάρτι τουρ", short: "Χώρες που απλώς δεν κοιμούνται", judge: "διαλέγει ποια διαδρομή έχει πιο πολλή πλάκα" },
          place: { title: "Πού θα γίνει ρέιβ", short: "Διάλεξε πού θα χορέψεις εκεί που δεν επιτρέπεται", judge: "διαλέγει ποιο μέρος έχει το πιο πολύ θράσος" },
          animal: { title: "Ζώα καλεσμένα", short: "Καλεσμένοι με πατούσες, οπλές και δόντια", judge: "διαλέγει ποιο θηριοτροφείο έχει πιο πολλή πλάκα" },
          painting: { title: "Τέχνη στους τοίχους", short: "Τι θα κρεμάσεις για να κολλήσουν όλοι", judge: "διαλέγει ποιοι τοίχοι φτιάχνουν την ατμόσφαιρα" },
          company: { title: "Ποιος πληρώνει", short: "Χορηγοί που θα πληρώσουν όλο τον λογαριασμό", judge: "διαλέγει ποιανού η εταιρική γιορτή έγινε θρύλος" },
          club: { title: "Αφτερπάρτι", short: "Με ποιανού τους οπαδούς γιορτάζεις μετά", judge: "διαλέγει ποιος γιορτάζει καλύτερα" },
          profession: { title: "Ομάδα του πάρτι", short: "Οι ειδικοί που σώζουν κάθε γιορτή", judge: "διαλέγει ποια ομάδα έστησε την καλύτερη βραδιά" },
          invention: { title: "Μαραφέτια πάρτι", short: "Τα μαραφέτια χωρίς τα οποία δεν γίνεται πάρτι", judge: "διαλέγει ποιανού τα μαραφέτια έκαναν τη βραδιά" },
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
    judge: "выбирает музей, в который выстроится очередь",
    byKind: {
      artist: { title: "Музей музыки", short: "Кого выставить в музее музыки", judge: "выбирает, в чей зал потащат друзей" },
      film: { title: "Музей кино", short: "Фильмы, которым место в витрине", judge: "выбирает, чей зал не отпускает" },
      series: { title: "Зал сериалов", short: "Сериалы, на которые смотрят как на диковину", judge: "выбирает, чей зал страннее" },
      person: { title: "Кабинет диковин", short: "Люди, на которых сходятся поглазеть", judge: "выбирает, к кому будет очередь на улице" },
      character: { title: "Зал вымышленных", short: "Герои, ради которых купят билет", judge: "выбирает, чей зал соберёт очередь" },
      food: { title: "Музей еды", short: "Блюда, на которые смотрят с ужасом и восторгом", judge: "выбирает, чью витрину фотографируют больше" },
      city: { title: "Музей городов", short: "Города, которые сами похожи на экспонат", judge: "выбирает, чья коллекция городов страннее" },
      country: { title: "Музей стран", short: "Страны, которые сами как кабинет диковин", judge: "выбирает, чей зал удивит сильнее" },
      place: { title: "Зал чудес", short: "Места, от которых глаза на лоб", judge: "выбирает, чей зал диковиннее" },
      animal: { title: "Кабинет редкостей", short: "Звери, которых больше нигде не покажут", judge: "выбирает, чей зверинец удивительнее" },
      painting: { title: "Зал безумных картин", short: "Картины, у которых зависают с открытым ртом", judge: "выбирает, чья развеска страннее" },
      company: { title: "Музей корпораций", short: "Фирмы, чья история сама как экспонат", judge: "выбирает, чья витрина бизнеса страннее" },
      club: { title: "Музей курьёзов", short: "Клубы, чьи истории не придумаешь", judge: "выбирает, чья история курьёзнее" },
      profession: { title: "Музей профессий", short: "Работы, в которые не верят, пока не увидят", judge: "выбирает, чьи профессии удивительнее" },
      invention: { title: "Зал чудо-техники", short: "Изобретения, которым место под стеклом", judge: "выбирает, у чьих витрин застревают надолго" },
    },
    t: {
      en: {
        title: "Museum of Oddities",
        short: "Gather the things people show up just to gawk at",
        judge: "picks the museum with the queue around the block",
        byKind: {
          artist: { title: "Museum of Music", short: "Who goes on display in a music museum", judge: "picks the hall people drag their friends to" },
          film: { title: "Museum of Film", short: "Films that belong in a display case", judge: "picks whose hall nobody can walk away from" },
          series: { title: "Hall of Series", short: "Shows people study like curiosities", judge: "picks whose hall is the strangest" },
          person: { title: "Cabinet of Curios", short: "People everyone turns up to gawk at", judge: "picks who gets the queue out on the street" },
          character: { title: "Hall of Fiction", short: "Characters worth buying a ticket for", judge: "picks whose hall sells the most tickets" },
          food: { title: "Museum of Food", short: "Dishes people stare at in horror and awe", judge: "picks whose case gets photographed most" },
          city: { title: "Museum of Cities", short: "Cities that are exhibits all by themselves", judge: "picks whose collection of cities is odder" },
          country: { title: "Museum of Nations", short: "Countries that are cabinets of curiosities already", judge: "picks whose hall surprises harder" },
          place: { title: "Hall of Wonders", short: "Places that make your jaw drop", judge: "picks whose hall is the weirdest" },
          animal: { title: "Cabinet of Rarities", short: "Animals no other zoo will ever show", judge: "picks whose menagerie is more astonishing" },
          painting: { title: "Hall of Mad Art", short: "Paintings people stand in front of, mouth open", judge: "picks whose hang is stranger" },
          company: { title: "Museum of Business", short: "Companies whose history is an exhibit already", judge: "picks whose business display is odder" },
          club: { title: "Museum of Oddballs", short: "Clubs with histories you could not make up", judge: "picks whose story is the more ridiculous" },
          profession: { title: "Museum of Jobs", short: "Jobs nobody believes in until they see them", judge: "picks whose jobs are more astonishing" },
          invention: { title: "Hall of Gadgets", short: "Inventions that belong behind glass", judge: "picks whose cases people get stuck at" },
        },
      },
      el: {
        title: "Μουσείο παραξενιών",
        short: "Μάζεψε πράγματα που θα έρθουν να χαζέψουν",
        judge: "διαλέγει το μουσείο που θα κάνει ουρά στον δρόμο",
        byKind: {
          artist: { title: "Μουσείο μουσικής", short: "Ποιοι μπαίνουν σε μουσείο μουσικής", judge: "διαλέγει σε ποια αίθουσα φέρνουν και τους φίλους" },
          film: { title: "Μουσείο ταινιών", short: "Ταινίες που θέλουν προθήκη", judge: "διαλέγει ποια αίθουσα δεν σε αφήνει να φύγεις" },
          series: { title: "Αίθουσα σειρών", short: "Σειρές που τις κοιτάς σαν αξιοπερίεργα", judge: "διαλέγει ποια αίθουσα είναι πιο αλλόκοτη" },
          person: { title: "Θάλαμος παραξενιών", short: "Άνθρωποι που όλοι έρχονται να χαζέψουν", judge: "διαλέγει ποιος βγάζει την ουρά στον δρόμο" },
          character: { title: "Αίθουσα μυθοπλασίας", short: "Ήρωες που αξίζουν εισιτήριο", judge: "διαλέγει ποια αίθουσα κόβει τα πιο πολλά εισιτήρια" },
          food: { title: "Μουσείο φαγητού", short: "Πιάτα που τα κοιτάς με φρίκη και θαυμασμό", judge: "διαλέγει ποια προθήκη φωτογραφίζεται πιο πολύ" },
          city: { title: "Μουσείο πόλεων", short: "Πόλεις που είναι εκθέματα από μόνες τους", judge: "διαλέγει ποια συλλογή πόλεων είναι πιο παράξενη" },
          country: { title: "Μουσείο χωρών", short: "Χώρες που είναι ήδη θάλαμος παραξενιών", judge: "διαλέγει ποια αίθουσα εκπλήσσει πιο πολύ" },
          place: { title: "Αίθουσα θαυμάτων", short: "Μέρη που σου πέφτει το σαγόνι", judge: "διαλέγει ποια αίθουσα είναι πιο αλλόκοτη" },
          animal: { title: "Θάλαμος σπάνιων", short: "Ζώα που δεν τα δείχνει κανένας άλλος", judge: "διαλέγει ποιο θηριοτροφείο εκπλήσσει πιο πολύ" },
          painting: { title: "Αίθουσα τρελής τέχνης", short: "Πίνακες που μένεις μπροστά τους με ανοιχτό στόμα", judge: "διαλέγει ποιο κρέμασμα είναι πιο παράξενο" },
          company: { title: "Μουσείο επιχειρήσεων", short: "Εταιρείες που η ιστορία τους είναι έκθεμα", judge: "διαλέγει ποια προθήκη είναι πιο παράξενη" },
          club: { title: "Μουσείο γκαφών", short: "Σύλλογοι με ιστορίες που δεν τις βγάζει μυαλό", judge: "διαλέγει ποια ιστορία είναι πιο απίστευτη" },
          profession: { title: "Μουσείο επαγγελμάτων", short: "Δουλειές που δεν τις πιστεύεις αν δεν τις δεις", judge: "διαλέγει ποια επαγγέλματα εκπλήσσουν πιο πολύ" },
          invention: { title: "Αίθουσα μαραφετιών", short: "Εφευρέσεις που θέλουν βιτρίνα", judge: "διαλέγει σε ποιες προθήκες κολλάει ο κόσμος" },
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
    judge: "решает, чья посылка сильнее перекроит историю",
    byKind: {
      film: { title: "Кино для рыцарей", short: "Что показать Средневековью на большом экране", judge: "решает, от чьего сеанса история пойдёт иначе" },
      series: { title: "Сериал для инквизиции", short: "Что запустить в прошлом на всю деревню", judge: "решает, чей сериал сильнее встряхнёт прошлое" },
      person: { title: "Гости из будущего", short: "Кого забросить в Средние века", judge: "решает, кто сильнее перекроит историю" },
      character: { title: "Герои в прошлом", short: "Кого выпустить в Средневековье", judge: "решает, чьи герои перевернут прошлое" },
      food: { title: "Ужин для короля", short: "Чем накормить средневековый двор", judge: "решает, чей стол удивит прошлое сильнее" },
      city: { title: "Город из будущего", short: "Какой город перенести на тысячу лет назад", judge: "решает, чей город сильнее изменит историю" },
      country: { title: "Страна в прошлом", short: "Целую страну — на тысячу лет назад", judge: "решает, чья страна перепишет историю" },
      place: { title: "Чудо в прошлом", short: "Какое место перенести в Средневековье", judge: "решает, чьё чудо сильнее поразит прошлое" },
      animal: { title: "Зверь для прошлого", short: "Кого выпустить в средневековый лес", judge: "решает, чьи звери сильнее изменят историю" },
      painting: { title: "Картина для монахов", short: "Что повесить в средневековом храме", judge: "решает, чьи картины сильнее встряхнут прошлое" },
      company: { title: "Фирма в Средневековье", short: "Какую фирму открыть в Средних веках", judge: "решает, чей бизнес перекроит прошлое" },
      club: { title: "Турнир для короля", short: "Кого выставить на турнир перед королём", judge: "решает, чей клуб сильнее удивит прошлое" },
      profession: { title: "Спецы в прошлое", short: "Кого отправить учить Средневековье", judge: "решает, чьи спецы сильнее ускорят прогресс" },
    },
    t: {
      en: {
        title: "Send to the Past",
        short: "Pack a parcel for the Middle Ages",
        judge: "decides whose parcel rewrites history hardest",
        byKind: {
          film: { title: "Cinema for Knights", short: "What you screen for the Middle Ages", judge: "decides whose screening sends history off course" },
          series: { title: "Binge for the Past", short: "What you put on for the whole village", judge: "decides whose show shakes the past hardest" },
          person: { title: "Guests from Ahead", short: "Who you drop into the Middle Ages", judge: "decides who bends history furthest" },
          character: { title: "Heroes in the Past", short: "Who you let loose in the Middle Ages", judge: "decides whose heroes turn the past upside down" },
          food: { title: "Dinner for a King", short: "What you feed a medieval court", judge: "decides whose table impresses the past more" },
          city: { title: "City from the Future", short: "Which city you drop a thousand years back", judge: "decides whose city changes history most" },
          country: { title: "A Country Displaced", short: "A whole country, a thousand years back", judge: "decides whose country rewrites history" },
          place: { title: "Wonder in the Past", short: "Which landmark you move to the Middle Ages", judge: "decides whose wonder stuns the past more" },
          animal: { title: "Beast for the Past", short: "What you set loose in a medieval forest", judge: "decides whose animals change history more" },
          painting: { title: "Art for the Monks", short: "What you hang in a medieval church", judge: "decides whose paintings shake the past harder" },
          company: { title: "Medieval Startup", short: "Which company you open in the Middle Ages", judge: "decides whose business reshapes the past" },
          club: { title: "Tournament Squad", short: "Who you enter in a tournament before the king", judge: "decides whose club stuns the past more" },
          profession: { title: "Experts to the Past", short: "Who you send to teach the Middle Ages", judge: "decides whose experts speed up progress most" },
        },
      },
      el: {
        title: "Στείλε στο παρελθόν",
        short: "Φτιάξε ένα πακέτο για τον Μεσαίωνα",
        judge: "κρίνει ποιο πακέτο αλλάζει πιο βίαια την ιστορία",
        byKind: {
          film: { title: "Σινεμά για ιππότες", short: "Τι θα προβάλεις στον Μεσαίωνα", judge: "κρίνει ποια προβολή βγάζει την ιστορία από τη ρότα" },
          series: { title: "Σειρά στον Μεσαίωνα", short: "Τι θα βάλεις να δει όλο το χωριό", judge: "κρίνει ποια σειρά ταρακουνάει πιο πολύ το παρελθόν" },
          person: { title: "Επισκέπτες από αύριο", short: "Ποιους θα ρίξεις στον Μεσαίωνα", judge: "κρίνει ποιος λυγίζει πιο πολύ την ιστορία" },
          character: { title: "Ήρωες στον Μεσαίωνα", short: "Ποιους θα αφήσεις λυτούς στον Μεσαίωνα", judge: "κρίνει ποιοι ήρωες αναποδογυρίζουν το παρελθόν" },
          food: { title: "Δείπνο για βασιλιά", short: "Τι θα σερβίρεις σε μεσαιωνική αυλή", judge: "κρίνει ποιο τραπέζι εντυπωσιάζει πιο πολύ" },
          city: { title: "Πόλη από το μέλλον", short: "Ποια πόλη θα στείλεις χίλια χρόνια πίσω", judge: "κρίνει ποια πόλη αλλάζει πιο πολύ την ιστορία" },
          country: { title: "Χώρα στο παρελθόν", short: "Μια ολόκληρη χώρα, χίλια χρόνια πίσω", judge: "κρίνει ποια χώρα ξαναγράφει την ιστορία" },
          place: { title: "Θαύμα στο παρελθόν", short: "Ποιο αξιοθέατο θα πάει στον Μεσαίωνα", judge: "κρίνει ποιο θαύμα αφήνει άφωνο το παρελθόν" },
          animal: { title: "Θηρίο στο παρελθόν", short: "Τι θα αφήσεις λυτό στο μεσαιωνικό δάσος", judge: "κρίνει ποια ζώα αλλάζουν πιο πολύ την ιστορία" },
          painting: { title: "Τέχνη για μοναχούς", short: "Τι θα κρεμάσεις σε μεσαιωνικό ναό", judge: "κρίνει ποιοι πίνακες ταρακουνούν πιο πολύ το παρελθόν" },
          company: { title: "Μπίζνα στον Μεσαίωνα", short: "Ποια εταιρεία θα ανοίξεις στον Μεσαίωνα", judge: "κρίνει ποια επιχείρηση αλλάζει το παρελθόν" },
          club: { title: "Τουρνουά για βασιλιά", short: "Ποιον θα βάλεις σε τουρνουά μπροστά στον βασιλιά", judge: "κρίνει ποιος σύλλογος εντυπωσιάζει πιο πολύ" },
          profession: { title: "Ειδικοί στο παρελθόν", short: "Ποιους θα στείλεις να μάθουν στον Μεσαίωνα", judge: "κρίνει ποιοι ειδικοί τρέχουν πιο γρήγορα την πρόοδο" },
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
    judge: "выбирает подарок, который бесит вежливее всего",
    byKind: {
      artist: { title: "Плейлист для врага", short: "Музыка, от которой враг завоет", judge: "выбирает, чей плейлист невыносимее" },
      film: { title: "Киновечер для врага", short: "Что заставить врага смотреть до конца", judge: "выбирает, чей сеанс мучительнее" },
      series: { title: "Сериал для врага", short: "Что подсунуть врагу на все выходные", judge: "выбирает, от чьего сериала врагу тоскливее" },
      person: { title: "Гости для врага", short: "Кого подселить врагу на неделю", judge: "выбирает, от чьих гостей врагу хуже" },
      character: { title: "Соседи для врага", short: "Кого поселить врагу за стенкой", judge: "выбирает, чьи соседи доведут быстрее" },
      food: { title: "Ужин для врага", short: "Чем угостить врага, чтобы он загрустил", judge: "выбирает, чей ужин обиднее" },
      city: { title: "Путёвка врагу", short: "Куда отправить врага отдыхать", judge: "выбирает, чья путёвка обиднее" },
      country: { title: "Билет в один конец", short: "В какую страну сослать врага", judge: "выбирает, чья ссылка изящнее" },
      place: { title: "Экскурсия врагу", short: "Куда сводить врага на целый день", judge: "выбирает, чья экскурсия тоскливее" },
      animal: { title: "Питомец для врага", short: "Кого подарить врагу в маленькую квартиру", judge: "выбирает, чей питомец невыносимее" },
      painting: { title: "Картина врагу", short: "Что повесить врагу над диваном", judge: "выбирает, чья картина обиднее" },
      company: { title: "Акции для врага", short: "Чьи акции подарить врагу на память", judge: "выбирает, чей подарок обесценится быстрее" },
      club: { title: "Клуб для врага", short: "За кого заставить врага болеть", judge: "выбирает, за кого болеть больнее" },
      profession: { title: "Работа для врага", short: "Кем враг будет работать до пенсии", judge: "выбирает, чья вакансия безнадёжнее" },
      invention: { title: "Гаджет для врага", short: "Какую штуковину вручить врагу с бантиком", judge: "выбирает, чей гаджет бесполезнее" },
    },
    t: {
      en: {
        title: "Gift for an Enemy",
        short: "Wrap up something your enemy will politely hate",
        judge: "picks the gift that annoys most elegantly",
        byKind: {
          artist: { title: "Playlist for a Foe", short: "Music that makes your enemy howl", judge: "picks whose playlist is more unbearable" },
          film: { title: "Movie Night Revenge", short: "What your enemy has to sit through", judge: "picks whose screening is more painful" },
          series: { title: "Series for a Foe", short: "What to hand your enemy for the weekend", judge: "picks whose show is the bigger slog" },
          person: { title: "Houseguests", short: "Who moves in with your enemy for a week", judge: "picks whose guests wreck the mood more" },
          character: { title: "Neighbours", short: "Who moves in next door to your enemy", judge: "picks whose neighbours break them faster" },
          food: { title: "Dinner for a Foe", short: "What to serve your enemy to ruin the day", judge: "picks whose dinner stings more" },
          city: { title: "Holiday Booked", short: "Where you send your enemy on holiday", judge: "picks whose holiday stings more" },
          country: { title: "One-Way Ticket", short: "Which country you exile your enemy to", judge: "picks whose exile is more elegant" },
          place: { title: "Day Trip Revenge", short: "Where your enemy spends the whole day", judge: "picks whose day out is the drearier" },
          animal: { title: "Pet for a Foe", short: "What you gift into their tiny flat", judge: "picks whose pet is more unbearable" },
          painting: { title: "Art for a Foe", short: "What goes up above their sofa", judge: "picks whose painting is the bigger insult" },
          company: { title: "Shares for a Foe", short: "Whose shares you gift as a keepsake", judge: "picks whose gift loses value fastest" },
          club: { title: "Club for a Foe", short: "Who your enemy has to support now", judge: "picks which club hurts more to follow" },
          profession: { title: "Job for a Foe", short: "What your enemy does for a living now", judge: "picks whose job offer is the bleaker" },
          invention: { title: "Gadget for a Foe", short: "What you hand them with a bow on top", judge: "picks whose gadget is more useless" },
        },
      },
      el: {
        title: "Δώρο στον εχθρό",
        short: "Φτιάξε ένα δώρο που θα το μισήσει ευγενικά",
        judge: "διαλέγει το δώρο που εκνευρίζει πιο κομψά",
        byKind: {
          artist: { title: "Πλεϊλίστ για εχθρό", short: "Μουσική που θα τον κάνει να ουρλιάξει", judge: "διαλέγει ποια πλεϊλίστ είναι πιο ανυπόφορη" },
          film: { title: "Σινεμά-εκδίκηση", short: "Τι θα αναγκαστεί να δει μέχρι τέλους", judge: "διαλέγει ποια προβολή είναι πιο βασανιστική" },
          series: { title: "Σειρά για εχθρό", short: "Τι θα του δώσεις για όλο το σαββατοκύριακο", judge: "διαλέγει ποια σειρά είναι πιο αγγαρεία" },
          person: { title: "Καλεσμένοι-τιμωρία", short: "Ποιους θα του βάλεις σπίτι για μια βδομάδα", judge: "διαλέγει ποιοι καλεσμένοι του χαλάνε πιο πολύ τη ζωή" },
          character: { title: "Γείτονες-τιμωρία", short: "Ποιους θα του βάλεις τοίχο με τοίχο", judge: "διαλέγει ποιοι γείτονες τον τρελαίνουν πιο γρήγορα" },
          food: { title: "Δείπνο για εχθρό", short: "Τι θα του σερβίρεις για να του χαλάσεις τη μέρα", judge: "διαλέγει ποιο δείπνο πονάει πιο πολύ" },
          city: { title: "Εισιτήριο-δώρο", short: "Πού θα τον στείλεις διακοπές", judge: "διαλέγει ποιες διακοπές πονάνε πιο πολύ" },
          country: { title: "Χωρίς επιστροφή", short: "Σε ποια χώρα θα τον εξορίσεις", judge: "διαλέγει ποια εξορία είναι πιο κομψή" },
          place: { title: "Εκδρομή-τιμωρία", short: "Πού θα περάσει όλη του τη μέρα", judge: "διαλέγει ποια εκδρομή είναι πιο βαρετή" },
          animal: { title: "Κατοικίδιο-εκδίκηση", short: "Τι θα του χαρίσεις στο μικρό του σπίτι", judge: "διαλέγει ποιο κατοικίδιο είναι πιο ανυπόφορο" },
          painting: { title: "Πίνακας για εχθρό", short: "Τι θα κρεμάσει πάνω από τον καναπέ", judge: "διαλέγει ποιος πίνακας προσβάλλει πιο πολύ" },
          company: { title: "Μετοχές για εχθρό", short: "Ποιες μετοχές θα του χαρίσεις για ενθύμιο", judge: "διαλέγει ποιο δώρο χάνει πιο γρήγορα την αξία του" },
          club: { title: "Ομάδα για εχθρό", short: "Ποια ομάδα θα αναγκαστεί να υποστηρίζει", judge: "διαλέγει ποια ομάδα πονάει πιο πολύ" },
          profession: { title: "Δουλειά για εχθρό", short: "Τι δουλειά θα κάνει από δω και πέρα", judge: "διαλέγει ποια δουλειά είναι πιο απελπιστική" },
          invention: { title: "Μαραφέτι-δώρο", short: "Τι θα του δώσεις με φιόγκο από πάνω", judge: "διαλέγει ποιο μαραφέτι είναι πιο άχρηστο" },
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
