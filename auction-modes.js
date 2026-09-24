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
    judge: "оценивает силу каждого лота и то, как они работают вместе",
    byKind: {
      artist: { title: "Лайнап фестиваля", short: "Собери фестиваль, на который пойдут", judge: "оценивает хедлайнеров, сочетаемость состава и пошёл бы ты на такой фест" },
      film: { title: "Киномарафон", short: "Вечер, который смотрят не отрываясь", judge: "оценивает качество фильмов, разнообразие и как они смотрятся подряд" },
      series: { title: "Сезон сериалов", short: "Подписка, от которой не оторваться", judge: "оценивает, затягивают ли сериалы и держится ли баланс жанров" },
      person: { title: "Ужин мечты", short: "Собери гостей, с которыми не заскучаешь", judge: "оценивает, насколько интересным и взрывным выйдет вечер за одним столом" },
      character: { title: "Отряд героев", short: "Команда, которая выигрывает замес", judge: "сравнивает силу персонажей и то, как их способности дополняют друг друга" },
      food: { title: "Меню ужина", short: "Собери ужин, который работает целиком", judge: "оценивает вкус, баланс блюд и складываются ли они в один ужин" },
      city: { title: "Маршрут мечты", short: "Поездка, которую захочется повторить", judge: "оценивает впечатления, разнообразие и реально ли проехать маршрут" },
      country: { title: "Кругосветка", short: "Собери маршрут вокруг света", judge: "оценивает впечатления, разнообразие и реально ли проехать маршрут" },
      place: { title: "Тур по чудесам", short: "Места, ради которых стоит лететь", judge: "оценивает впечатления и реально ли объехать все места за один тур" },
      animal: { title: "Зоопарк мечты", short: "Собери тех, на кого пойдут смотреть", judge: "оценивает зрелищность, разнообразие и на кого пойдут смотреть" },
      painting: { title: "Частная галерея", short: "Коллекция, которой можно хвастаться", judge: "оценивает ценность, узнаваемость картин и цельность коллекции" },
      company: { title: "Инвестпортфель", short: "Собери портфель, который вырастет", judge: "оценивает стоимость компаний, перспективы и диверсификацию" },
      club: { title: "Спортивная империя", short: "Клубы, которые берут титулы", judge: "считает титулы, аудиторию и стоимость клубов" },
      profession: { title: "Экипаж для острова", short: "Кто вытащит вас с необитаемого острова", judge: "оценивает, чьи навыки добудут еду, построят укрытие и вывезут с острова" },
      invention: { title: "Груз в прошлое", short: "Изобретения, которые перепишут историю", judge: "оценивает, насколько сильно и быстро изобретения изменят историю" },
    },
    t: {
      en: {
        title: "Best Set",
        short: "The classic: assemble the strongest set you can",
        judge: "rates how strong each pick is and how well they work together",
        byKind: {
          artist: { title: "Festival Line-up", short: "Build a festival people would show up to", judge: "rates the headliners, how the acts fit and whether you'd buy a ticket" },
          film: { title: "Movie Marathon", short: "A night nobody wants to pause", judge: "rates the films, the variety and how they play back to back" },
          series: { title: "Binge Season", short: "A subscription you cannot quit", judge: "rates how hooked you'd get and how balanced the genres are" },
          person: { title: "Dream Dinner", short: "Invite guests who keep the night alive", judge: "rates how lively and explosive the evening at one table would be" },
          character: { title: "Hero Squad", short: "A team that wins the brawl", judge: "weighs each character's power and how their abilities combine" },
          food: { title: "Dinner Menu", short: "Build a dinner that works as a whole", judge: "rates the taste, the balance and whether it adds up to one dinner" },
          city: { title: "Dream Trip", short: "A trip you would book all over again", judge: "rates the experiences, the variety and whether the route is doable" },
          country: { title: "Round the World", short: "Plot a route all the way around the globe", judge: "rates the experiences, the variety and whether the route is doable" },
          place: { title: "Wonders Tour", short: "Places worth getting on a plane for", judge: "rates the experiences and whether one trip can cover them all" },
          animal: { title: "Dream Zoo", short: "Gather the animals people queue up for", judge: "rates the spectacle, the variety and who people would come to see" },
          painting: { title: "Private Gallery", short: "A collection worth bragging about", judge: "rates the value, how famous the works are and how the collection holds together" },
          company: { title: "Investment Portfolio", short: "Build a portfolio that only goes up", judge: "rates the companies' value, prospects and diversification" },
          club: { title: "Sports Empire", short: "Clubs that actually lift trophies", judge: "counts the trophies, the fanbase and the value of the clubs" },
          profession: { title: "Island Crew", short: "Who gets you off a desert island", judge: "rates whose skills find food, build shelter and get everyone off the island" },
          invention: { title: "Cargo to the Past", short: "Inventions that rewrite history", judge: "rates how far and how fast the inventions would change history" },
        },
      },
      el: {
        title: "Καλύτερο σετ",
        short: "Το κλασικό: φτιάξε το πιο δυνατό σετ",
        judge: "κρίνει πόσο δυνατό είναι το καθένα και πώς δένουν μαζί",
        byKind: {
          artist: { title: "Λάιναπ φεστιβάλ", short: "Φτιάξε ένα φεστιβάλ που θα πάει ο κόσμος", judge: "κρίνει τα headliners, πώς δένουν τα ονόματα και αν θα έβγαζες εισιτήριο" },
          film: { title: "Μαραθώνιος ταινιών", short: "Μια βραδιά που δεν πατάς pause", judge: "κρίνει την ποιότητα, την ποικιλία και πώς βλέπονται η μία μετά την άλλη" },
          series: { title: "Σεζόν σειρών", short: "Μια συνδρομή που δεν την κλείνεις με τίποτα", judge: "κρίνει πόσο σε κολλάνε οι σειρές και αν ισορροπούν τα είδη" },
          person: { title: "Δείπνο των ονείρων", short: "Μάζεψε καλεσμένους που δεν τους βαριέσαι", judge: "κρίνει πόσο ενδιαφέρουσα και εκρηκτική θα βγει η βραδιά στο ίδιο τραπέζι" },
          character: { title: "Ομάδα ηρώων", short: "Μια ομάδα που κερδίζει τη μάχη", judge: "συγκρίνει τη δύναμη των χαρακτήρων και πώς συνδυάζονται οι ικανότητές τους" },
          food: { title: "Μενού δείπνου", short: "Φτιάξε ένα δείπνο που στέκει ολόκληρο", judge: "κρίνει τη γεύση, την ισορροπία και αν βγαίνει ένα δείπνο" },
          city: { title: "Ταξίδι των ονείρων", short: "Ένα ταξίδι που θα θες να το ξανακάνεις", judge: "κρίνει τις εμπειρίες, την ποικιλία και αν βγαίνει η διαδρομή" },
          country: { title: "Γύρος του κόσμου", short: "Φτιάξε μια διαδρομή γύρω από τον κόσμο", judge: "κρίνει τις εμπειρίες, την ποικιλία και αν βγαίνει η διαδρομή" },
          place: { title: "Τουρ στα θαύματα", short: "Μέρη που αξίζουν το αεροπλάνο", judge: "κρίνει τις εμπειρίες και αν χωράνε όλα σε ένα ταξίδι" },
          animal: { title: "Ιδανικός ζωολογικός", short: "Μάζεψε ζώα που αξίζουν την ουρά στο ταμείο", judge: "κρίνει το θέαμα, την ποικιλία και ποιους θα έρθει να δει ο κόσμος" },
          painting: { title: "Ιδιωτική γκαλερί", short: "Μια συλλογή για να καμαρώνεις", judge: "κρίνει την αξία, πόσο γνωστά είναι τα έργα και τη συνοχή της συλλογής" },
          company: { title: "Χαρτοφυλάκιο", short: "Φτιάξε ένα χαρτοφυλάκιο που ανεβαίνει", judge: "κρίνει την αξία, τις προοπτικές και τη διασπορά του χαρτοφυλακίου" },
          club: { title: "Αθλητική αυτοκρατορία", short: "Σύλλογοι που σηκώνουν τρόπαια", judge: "μετράει τρόπαια, κοινό και αξία των συλλόγων" },
          profession: { title: "Πλήρωμα για το νησί", short: "Ποιοι θα σε βγάλουν από το έρημο νησί", judge: "κρίνει ποιες δεξιότητες βρίσκουν φαγητό, στήνουν καταφύγιο και βγάζουν όλους από το νησί" },
          invention: { title: "Φορτίο στο παρελθόν", short: "Εφευρέσεις που ξαναγράφουν την ιστορία", judge: "κρίνει πόσο πολύ και πόσο γρήγορα θα άλλαζαν την ιστορία οι εφευρέσεις" },
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
    judge: "ищет самые несовместимые и нелепые сочетания",
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
        judge: "looks for the most mismatched, absurd combinations",
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
        judge: "ψάχνει τους πιο αταίριαστους και παράλογους συνδυασμούς",
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
    judge: "оценивает угрозу миру, зловещую харизму и слаженность банды",
    byKind: {
      artist: { title: "Банда со сцены", short: "Музыканты, из которых вышли бы отличные злодеи", judge: "оценивает зловещую харизму музыкантов и насколько они опасны вместе" },
      person: { title: "Совет злодеев", short: "Знаменитости, которые поделят мир между собой", judge: "оценивает влияние, харизму и договорится ли совет о захвате мира" },
      character: { title: "Лига суперзлодеев", short: "Злодеи, против которых у героев нет шансов", judge: "сравнивает силу злодеев и как их способности усиливают друг друга" },
      animal: { title: "Звериная орда", short: "Звери, от которых человечеству не отбиться", judge: "оценивает, насколько звери опасны для людей и как дополняют друг друга" },
      club: { title: "Клубы-злодеи", short: "Клубы, которые заберут весь спорт себе", judge: "оценивает деньги, влияние и армию фанатов — хватит ли, чтобы подмять спорт" },
      company: { title: "Корпорация зла", short: "Корпорации, которые тайно правят миром", judge: "оценивает деньги, власть над людьми и как корпорации усиливают друг друга" },
      profession: { title: "Штат суперзлодея", short: "Спецы, без которых логово не работает", judge: "оценивает, закрывают ли спецы всё, что нужно для захвата мира" },
    },
    t: {
      en: {
        title: "Supervillain League",
        short: "Assemble the crew that takes over the world",
        judge: "rates the threat to the world, sinister charisma and how the gang works together",
        byKind: {
          artist: { title: "Band Gone Bad", short: "Musicians who would make excellent villains", judge: "rates the musicians' sinister charisma and how dangerous they are together" },
          person: { title: "Council of Villains", short: "Celebrities who carve up the world between them", judge: "rates influence, charisma and whether the council could agree on a takeover" },
          character: { title: "Supervillain League", short: "Villains the heroes cannot possibly beat", judge: "weighs the villains' power and how their abilities stack up" },
          animal: { title: "Beast Horde", short: "Animals humanity could not fight off", judge: "rates how dangerous the animals are to people and how they combine as a horde" },
          club: { title: "Villain Clubs", short: "Clubs that would take the whole sport over", judge: "rates the money, influence and fanbase — enough to take the sport over?" },
          company: { title: "Evil Corporation", short: "Corporations that secretly run the world", judge: "rates the money, the grip on people and how the corporations feed each other" },
          profession: { title: "Evil Lair Staff", short: "The specialists every evil lair needs", judge: "rates whether the specialists cover everything a takeover needs" },
        },
      },
      el: {
        title: "Λίγκα σούπερ κακών",
        short: "Μάζεψε αυτούς που θα κατακτήσουν τον κόσμο",
        judge: "κρίνει την απειλή για τον κόσμο, τη σκοτεινή γοητεία και πόσο δένει η συμμορία",
        byKind: {
          artist: { title: "Μπάντα κακοποιών", short: "Μουσικοί που θα έκαναν εξαιρετικούς κακούς", judge: "κρίνει τη σκοτεινή γοητεία των μουσικών και πόσο επικίνδυνοι είναι μαζί" },
          person: { title: "Συμβούλιο κακών", short: "Διάσημοι που θα μοιράσουν τον κόσμο μεταξύ τους", judge: "κρίνει την επιρροή, τη γοητεία και αν το συμβούλιο θα συμφωνούσε στην κατάκτηση" },
          character: { title: "Λίγκα σούπερ κακών", short: "Κακοί που οι ήρωες δεν τους βγάζουν με τίποτα", judge: "συγκρίνει τη δύναμη των κακών και πώς ενισχύει ο ένας τον άλλον" },
          animal: { title: "Ορδή των ζώων", short: "Ζώα που η ανθρωπότητα δεν θα σταματούσε", judge: "κρίνει πόσο επικίνδυνα είναι τα ζώα για τους ανθρώπους και πώς δένουν σαν ορδή" },
          club: { title: "Σύλλογοι κακών", short: "Σύλλογοι που θα πάρουν όλο το άθλημα δικό τους", judge: "κρίνει χρήμα, επιρροή και οπαδούς — φτάνουν για να πάρουν το άθλημα;" },
          company: { title: "Εταιρεία του κακού", short: "Εταιρείες που κυβερνούν κρυφά τον κόσμο", judge: "κρίνει το χρήμα, τον έλεγχο στους ανθρώπους και πώς αλληλοτροφοδοτούνται οι εταιρείες" },
          profession: { title: "Προσωπικό του κακού", short: "Οι ειδικοί που θέλει κάθε κρησφύγετο κακού", judge: "κρίνει αν οι ειδικοί καλύπτουν ό,τι χρειάζεται μια κατάκτηση" },
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
    judge: "оценивает практическую пользу: прокормит ли, защитит ли и долго ли протянет",
    byKind: {
      person: { title: "Бункер знаменитостей", short: "Кого берёшь в бункер, когда всё рухнуло", judge: "оценивает, кто полезен в бункере: добудет еду, починит, защитит" },
      character: { title: "Отряд выживших", short: "Кто вытащит тебя из конца света", judge: "оценивает живучесть героев, навыки выживания и умение защитить своих" },
      food: { title: "Запас на бункер", short: "Чем питаться, когда магазинов больше нет", judge: "оценивает сытность, срок хранения и можно ли на этом жить месяцами" },
      city: { title: "Где пересидеть", short: "Города, в которых есть шанс дожить до весны", judge: "оценивает воду, еду, укрытия и насколько города далеки от угроз" },
      country: { title: "Куда бежать", short: "Страны, в которых пересидишь конец света", judge: "оценивает, где есть вода, еда, защита и меньше всего угроз" },
      place: { title: "Последнее убежище", short: "Где забаррикадироваться, когда всё рухнуло", judge: "оценивает, насколько место защищено и можно ли там жить и добыть еду" },
      animal: { title: "Звери-напарники", short: "Кто прокормит и защитит после конца света", judge: "оценивает пользу зверей: еда, охрана, перевозка грузов" },
      company: { title: "Корпорации-бункеры", short: "Чьи склады и заводы спасут после краха", judge: "оценивает, что компании дадут без интернета и банков: еду, энергию, инструменты" },
      club: { title: "Кланы со стадионов", short: "Стадион как крепость, фанаты как армия", judge: "оценивает, сколько у клуба фанатов, насколько они сплочены и удержат ли оборону" },
      invention: { title: "Что взять в бункер", short: "Изобретения, без которых не выжить", judge: "оценивает, что даст еду, воду, тепло и защиту, а что окажется балластом" },
    },
    t: {
      en: {
        title: "Apocalypse Survival",
        short: "Gather what gets you through the end of the world",
        judge: "rates practical use: will it feed you, protect you and last",
        byKind: {
          person: { title: "Celebrity Bunker", short: "Who you take into the bunker when it all falls apart", judge: "rates who's useful in a bunker: who finds food, fixes things and defends it" },
          character: { title: "Survivor Squad", short: "Who drags you out of the apocalypse", judge: "rates the characters' toughness, survival skills and ability to protect the group" },
          food: { title: "Bunker Supplies", short: "What you eat once the shops are gone", judge: "rates how filling it is, how long it keeps and whether you can live on it for months" },
          city: { title: "Where to Sit It Out", short: "Cities where you might live to see the spring", judge: "rates water, food, shelter and how far the cities are from danger" },
          country: { title: "Where to Run", short: "Countries you could sit the apocalypse out in", judge: "rates where there's water, food, protection and the least danger" },
          place: { title: "Last Refuge", short: "Where to barricade yourself when it all falls apart", judge: "rates how protected each place is and whether you can live and find food there" },
          animal: { title: "Survival Partners", short: "Who feeds you and guards you after the collapse", judge: "rates the animals' use: food, guarding, carrying loads" },
          company: { title: "Bunker Corporations", short: "Whose warehouses and factories save you after the crash", judge: "rates what the companies still give you without internet and banks: food, energy, tools" },
          club: { title: "Stadium Clans", short: "The stadium is the fortress, the fans are the army", judge: "rates the fanbase's size, loyalty and ability to hold the line" },
          invention: { title: "Bunker Cargo", short: "The inventions you cannot survive without", judge: "rates what gives food, water, warmth and protection and what's dead weight" },
        },
      },
      el: {
        title: "Μετά την αποκάλυψη",
        short: "Μάζεψε ό,τι θα σε βγάλει από το τέλος του κόσμου",
        judge: "κρίνει την πρακτική χρησιμότητα: αν ταΐζει, αν προστατεύει και πόσο αντέχει",
        byKind: {
          person: { title: "Καταφύγιο διάσημων", short: "Ποιους παίρνεις στο καταφύγιο όταν όλα καταρρέουν", judge: "κρίνει ποιοι χρησιμεύουν στο καταφύγιο: ποιος βρίσκει φαγητό, επισκευάζει, προστατεύει" },
          character: { title: "Ομάδα επιβίωσης", short: "Ποιοι θα σε βγάλουν από την αποκάλυψη", judge: "κρίνει την αντοχή των χαρακτήρων, τις δεξιότητες επιβίωσης και αν προστατεύουν την ομάδα" },
          food: { title: "Προμήθειες καταφυγίου", short: "Τι θα τρως όταν δεν υπάρχουν μαγαζιά", judge: "κρίνει πόσο χορταίνει, πόσο κρατάει και αν ζεις με αυτό για μήνες" },
          city: { title: "Πού θα κρυφτείς", short: "Πόλεις όπου έχεις ελπίδα να δεις άνοιξη", judge: "κρίνει νερό, φαγητό, καταφύγια και πόσο μακριά είναι οι πόλεις από τον κίνδυνο" },
          country: { title: "Πού να το σκάσεις", short: "Χώρες όπου βγάζεις το τέλος του κόσμου", judge: "κρίνει πού υπάρχει νερό, φαγητό, προστασία και ο λιγότερος κίνδυνος" },
          place: { title: "Τελευταίο καταφύγιο", short: "Πού θα ταμπουρωθείς όταν όλα καταρρέουν", judge: "κρίνει πόσο προστατευμένο είναι το μέρος και αν ζεις και βρίσκεις φαγητό εκεί" },
          animal: { title: "Σύντροφοι επιβίωσης", short: "Ποιοι θα σε θρέψουν και θα σε φυλάξουν", judge: "κρίνει τη χρησιμότητα των ζώων: φαγητό, φύλαξη, μεταφορά" },
          company: { title: "Εταιρείες-καταφύγια", short: "Ποιανού οι αποθήκες και τα εργοστάσια σώζουν", judge: "κρίνει τι δίνουν οι εταιρείες χωρίς ίντερνετ και τράπεζες: φαγητό, ενέργεια, εργαλεία" },
          club: { title: "Κλαν των γηπέδων", short: "Το γήπεδο κάστρο, οι οπαδοί στρατός", judge: "κρίνει πόσοι είναι οι οπαδοί, πόσο δεμένοι και αν κρατάνε άμυνα" },
          invention: { title: "Φορτίο καταφυγίου", short: "Εφευρέσεις χωρίς τις οποίες δεν επιβιώνεις", judge: "κρίνει τι δίνει φαγητό, νερό, ζέστη και προστασία και τι είναι άχρηστο βάρος" },
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
    judge: "оценивает веселье, неожиданность и атмосферу — вспомнят ли вечер через год",
    // invention намеренно без своей строки title: общая «Вечеринка года» подходит гаджетам
    // как есть, а тест на запасной текст держится именно за эту пару.
    byKind: {
      artist: { title: "Музыка на вечеринке", short: "Кто выступает у тебя до самого утра", judge: "оценивает, под кого танцуют до рассвета и насколько неожиданный микс" },
      film: { title: "Кино на вечеринке", short: "Что крутить на экране, когда все пришли", judge: "оценивает, под какие фильмы весело шумной компании и никто не заскучает" },
      series: { title: "Марафон до утра", short: "Что включить, чтобы никто не ушёл спать", judge: "оценивает, какие сериалы держат компанию до утра и дают поводы для шуток" },
      person: { title: "Список гостей", short: "Кого позвать, чтобы вечер запомнили", judge: "оценивает, насколько весёлыми и непредсказуемыми будут гости вместе" },
      character: { title: "Гости из вымысла", short: "Позови героев, которые разнесут вечеринку", judge: "оценивает, какие герои зажгут и устроят самые неожиданные истории" },
      food: { title: "Стол для вечеринки", short: "Еда, которую сметут до полуночи", judge: "оценивает, как стол заходит толпе: удобно ли брать, весело ли и вкусно" },
      city: { title: "Где гуляем", short: "Города, в которых ночь не кончается", judge: "оценивает ночную жизнь, атмосферу и сколько историй привезёшь" },
      country: { title: "Тур по вечеринкам", short: "Страны, в которых не спят по ночам", judge: "оценивает ночную жизнь, праздники и атмосферу стран по пути" },
      place: { title: "Где закатить рейв", short: "Выбери, где танцевать там, где нельзя", judge: "оценивает, насколько место неожиданное для рейва и какую даст атмосферу" },
      animal: { title: "Звери на вечеринке", short: "Гости с лапами, копытами и клыками", judge: "оценивает, с какими зверями гостям веселее и какой выйдет хаос" },
      painting: { title: "Картины на стенах", short: "Чем завесить стены, чтобы все залипли", judge: "оценивает, какую атмосферу создадут картины и о чём заговорят гости" },
      company: { title: "Кто платит за вечер", short: "Спонсоры, которые оплатят весь банкет", judge: "оценивает бюджет, размах и неожиданности корпоратива" },
      club: { title: "После матча", short: "С чьими фанатами гулять после матча", judge: "оценивает, чьи фанаты празднуют громче и чьи победы дают лучшие истории" },
      profession: { title: "Команда праздника", short: "Спецы, которые вытянут любой праздник", judge: "оценивает, кто устроит праздник: музыка, еда, шоу и порядок" },
      invention: { title: "Гаджеты для вечера", short: "Гаджеты, без которых вечеринка не та", judge: "оценивает, какие изобретения добавят веселья и неожиданных моментов" },
    },
    t: {
      en: {
        title: "Party of the Year",
        short: "Throw a party nobody wants to leave",
        judge: "rates the fun, the surprise and the vibe — will people remember it in a year",
        byKind: {
          artist: { title: "Who's Playing", short: "Who is on stage at your place till sunrise", judge: "rates who keeps people dancing till dawn and how surprising the mix is" },
          film: { title: "Party Screening", short: "What goes on the screen once everyone is in", judge: "rates which films work for a loud crowd and keep everyone awake" },
          series: { title: "All-Nighter Binge", short: "What keeps everybody from going to bed", judge: "rates which shows keep the group up till morning and give them things to joke about" },
          person: { title: "The Guest List", short: "Who to invite so the night gets remembered", judge: "rates how fun and unpredictable the guests would be together" },
          character: { title: "Fictional Guests", short: "Invite the characters who wreck the place", judge: "rates which characters bring the energy and the wildest stories" },
          food: { title: "Party Spread", short: "Food that is gone before midnight", judge: "rates how the spread works for a crowd: easy to grab, fun and tasty" },
          city: { title: "Where We Go Out", short: "Cities where the night never ends", judge: "rates the nightlife, the vibe and how many stories you'd bring home" },
          country: { title: "Party World Tour", short: "Countries that simply do not sleep", judge: "rates the nightlife, the festivals and the vibe of every stop" },
          place: { title: "Where to Rave", short: "Pick the spot where dancing is not allowed", judge: "rates how unexpected the venue is for a rave and the vibe it gives" },
          animal: { title: "Animals Invited", short: "Guests with paws, hooves and fangs", judge: "rates which animals make it more fun and how much chaos follows" },
          painting: { title: "Art on the Walls", short: "What goes on the walls to hypnotise everyone", judge: "rates the vibe the paintings set and what guests will talk about" },
          company: { title: "Who Pays for It", short: "Sponsors who pick up the whole tab", judge: "rates the budget, the scale and the surprises of the office party" },
          club: { title: "Afterparty Crew", short: "Whose fans you celebrate with after the match", judge: "rates whose fans party loudest and whose wins make the best stories" },
          profession: { title: "The Party Crew", short: "The pros who can save any party", judge: "rates who can throw the party: music, food, show and keeping it together" },
          invention: { title: "Party Gadgets", short: "The gadgets a party is nothing without", judge: "rates which inventions add fun and unexpected moments" },
        },
      },
      el: {
        title: "Πάρτι της χρονιάς",
        short: "Φτιάξε ένα πάρτι που δεν φεύγει κανείς",
        judge: "κρίνει κέφι, έκπληξη και ατμόσφαιρα — θα τη θυμούνται σε έναν χρόνο;",
        byKind: {
          artist: { title: "Ποιοι παίζουν", short: "Ποιοι παίζουν στο πάρτι σου μέχρι το πρωί", judge: "κρίνει ποιοι κρατάνε τον χορό ως το πρωί και πόσο απρόσμενο είναι το μείγμα" },
          film: { title: "Προβολή στο πάρτι", short: "Τι παίζει στην οθόνη μόλις μαζευτούν όλοι", judge: "κρίνει ποιες ταινίες ταιριάζουν σε φασαριόζικη παρέα χωρίς να βαρεθεί κανείς" },
          series: { title: "Μαραθώνιος ως το πρωί", short: "Τι θα βάλεις για να μη πάει κανείς για ύπνο", judge: "κρίνει ποιες σειρές κρατάνε την παρέα ως το πρωί και δίνουν αφορμές για αστεία" },
          person: { title: "Λίστα καλεσμένων", short: "Ποιους καλείς για να μείνει η βραδιά στην ιστορία", judge: "κρίνει πόσο κεφάτοι και απρόβλεπτοι θα είναι οι καλεσμένοι μαζί" },
          character: { title: "Ήρωες στο πάρτι", short: "Κάλεσε ήρωες που θα διαλύσουν το σπίτι", judge: "κρίνει ποιοι χαρακτήρες φέρνουν κέφι και τις πιο τρελές ιστορίες" },
          food: { title: "Μπουφές πάρτι", short: "Φαγητό που εξαφανίζεται πριν τα μεσάνυχτα", judge: "κρίνει πώς πάει το τραπέζι σε κόσμο: εύκολο, διασκεδαστικό και νόστιμο" },
          city: { title: "Πού βγαίνουμε", short: "Πόλεις όπου η νύχτα δεν τελειώνει ποτέ", judge: "κρίνει τη νυχτερινή ζωή, την ατμόσφαιρα και πόσες ιστορίες θα φέρεις πίσω" },
          country: { title: "Παγκόσμιο πάρτι τουρ", short: "Χώρες που απλώς δεν κοιμούνται", judge: "κρίνει νυχτερινή ζωή, γιορτές και ατμόσφαιρα σε κάθε στάση" },
          place: { title: "Πού θα γίνει ρέιβ", short: "Διάλεξε πού θα χορέψεις εκεί που δεν επιτρέπεται", judge: "κρίνει πόσο απρόσμενο είναι το μέρος για ρέιβ και τι ατμόσφαιρα δίνει" },
          animal: { title: "Ζώα καλεσμένα", short: "Καλεσμένοι με πατούσες, οπλές και δόντια", judge: "κρίνει με ποια ζώα έχει πιο πολλή πλάκα και πόσο χάος θα γίνει" },
          painting: { title: "Τέχνη στους τοίχους", short: "Τι θα κρεμάσεις για να κολλήσουν όλοι", judge: "κρίνει τι ατμόσφαιρα στήνουν οι πίνακες και για τι θα μιλάνε οι καλεσμένοι" },
          company: { title: "Ποιος πληρώνει", short: "Χορηγοί που θα πληρώσουν όλο τον λογαριασμό", judge: "κρίνει τον προϋπολογισμό, το μέγεθος και τις εκπλήξεις του πάρτι" },
          club: { title: "Αφτερπάρτι", short: "Με ποιανού τους οπαδούς γιορτάζεις μετά", judge: "κρίνει ποιων οι οπαδοί γιορτάζουν πιο δυνατά και ποιων οι νίκες έχουν τις καλύτερες ιστορίες" },
          profession: { title: "Ομάδα του πάρτι", short: "Οι ειδικοί που σώζουν κάθε γιορτή", judge: "κρίνει ποιοι στήνουν το πάρτι: μουσική, φαγητό, σόου και οργάνωση" },
          invention: { title: "Μαραφέτια πάρτι", short: "Τα μαραφέτια χωρίς τα οποία δεν γίνεται πάρτι", judge: "κρίνει ποιες εφευρέσεις φέρνουν κέφι και απρόσμενες στιγμές" },
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
    judge: "оценивает необычность, зрелищность и захочется ли всё сфотографировать",
    byKind: {
      artist: { title: "Музей музыки", short: "Кого выставить в музее музыки", judge: "оценивает, чьи экспонаты о музыкантах необычнее и зрелищнее" },
      film: { title: "Музей кино", short: "Фильмы, которым место в витрине", judge: "оценивает, какие фильмы дадут самые зрелищные и необычные экспонаты" },
      series: { title: "Зал сериалов", short: "Сериалы, на которые смотрят как на диковину", judge: "оценивает, чей зал необычнее и что захочется сфотографировать" },
      person: { title: "Кабинет диковин", short: "Люди, на которых сходятся поглазеть", judge: "оценивает, чьи личности необычнее и о ком захочется рассказать друзьям" },
      character: { title: "Зал вымышленных", short: "Герои, ради которых купят билет", judge: "оценивает, чьи герои зрелищнее и с кем захочется сфотографироваться" },
      food: { title: "Музей еды", short: "Блюда, на которые смотрят с ужасом и восторгом", judge: "оценивает, какие блюда необычнее и лучше смотрятся на фото" },
      city: { title: "Музей городов", short: "Города, которые сами похожи на экспонат", judge: "оценивает, какие города необычнее и чем удивят посетителей" },
      country: { title: "Музей стран", short: "Страны, которые сами как кабинет диковин", judge: "оценивает, какие страны необычнее и дадут самые яркие экспонаты" },
      place: { title: "Зал чудес", short: "Места, от которых глаза на лоб", judge: "оценивает, какие места диковиннее и зрелищнее на фото" },
      animal: { title: "Кабинет редкостей", short: "Звери, которых больше нигде не покажут", judge: "оценивает, какие звери редче, диковиннее и фотогеничнее" },
      painting: { title: "Зал безумных картин", short: "Картины, у которых зависают с открытым ртом", judge: "оценивает, какие картины страннее и зрелищнее смотрятся вместе" },
      company: { title: "Музей корпораций", short: "Фирмы, чья история сама как экспонат", judge: "оценивает, у каких компаний история и продукты необычнее" },
      club: { title: "Музей курьёзов", short: "Клубы, чьи истории не придумаешь", judge: "оценивает, у каких клубов история курьёзнее и есть что рассказать" },
      profession: { title: "Музей профессий", short: "Работы, в которые не верят, пока не увидят", judge: "оценивает, какие профессии необычнее и зрелищнее выглядят вживую" },
      invention: { title: "Зал чудо-техники", short: "Изобретения, которым место под стеклом", judge: "оценивает, какие изобретения зрелищнее и у каких витрин задержатся" },
    },
    t: {
      en: {
        title: "Museum of Oddities",
        short: "Gather the things people show up just to gawk at",
        judge: "rates how unusual and striking it is and whether people will want photos",
        byKind: {
          artist: { title: "Museum of Music", short: "Who goes on display in a music museum", judge: "rates whose musician exhibits are the most unusual and striking" },
          film: { title: "Museum of Film", short: "Films that belong in a display case", judge: "rates which films make the most striking, unusual exhibits" },
          series: { title: "Hall of Series", short: "Shows people study like curiosities", judge: "rates whose room is the strangest and what people will want to photograph" },
          person: { title: "Cabinet of Curios", short: "People everyone turns up to gawk at", judge: "rates whose people are the most unusual and worth telling friends about" },
          character: { title: "Hall of Fiction", short: "Characters worth buying a ticket for", judge: "rates whose characters are the most striking and photo-worthy" },
          food: { title: "Museum of Food", short: "Dishes people stare at in horror and awe", judge: "rates which dishes are the most unusual and look best in photos" },
          city: { title: "Museum of Cities", short: "Cities that are exhibits all by themselves", judge: "rates which cities are the most unusual and how they'd surprise visitors" },
          country: { title: "Museum of Nations", short: "Countries that are cabinets of curiosities already", judge: "rates which countries are the most unusual and make the boldest exhibits" },
          place: { title: "Hall of Wonders", short: "Places that make your jaw drop", judge: "rates which places are the most bizarre and photogenic" },
          animal: { title: "Cabinet of Rarities", short: "Animals no other zoo will ever show", judge: "rates which animals are the rarest, oddest and most photogenic" },
          painting: { title: "Hall of Mad Art", short: "Paintings people stand in front of, mouth open", judge: "rates which paintings are the strangest and most striking together" },
          company: { title: "Museum of Business", short: "Companies whose history is an exhibit already", judge: "rates which companies have the oddest stories and products" },
          club: { title: "Museum of Oddballs", short: "Clubs with histories you could not make up", judge: "rates which clubs have the quirkiest history and the best stories to share" },
          profession: { title: "Museum of Jobs", short: "Jobs nobody believes in until they see them", judge: "rates which jobs are the most unusual and striking to watch" },
          invention: { title: "Hall of Gadgets", short: "Inventions that belong behind glass", judge: "rates which inventions are the most striking and where people will linger" },
        },
      },
      el: {
        title: "Μουσείο παραξενιών",
        short: "Μάζεψε πράγματα που θα έρθουν να χαζέψουν",
        judge: "κρίνει πόσο ασυνήθιστο και εντυπωσιακό είναι και αν θα θες να το φωτογραφίσεις",
        byKind: {
          artist: { title: "Μουσείο μουσικής", short: "Ποιοι μπαίνουν σε μουσείο μουσικής", judge: "κρίνει ποια εκθέματα για μουσικούς είναι πιο ασυνήθιστα και εντυπωσιακά" },
          film: { title: "Μουσείο ταινιών", short: "Ταινίες που θέλουν προθήκη", judge: "κρίνει ποιες ταινίες δίνουν τα πιο εντυπωσιακά και ασυνήθιστα εκθέματα" },
          series: { title: "Αίθουσα σειρών", short: "Σειρές που τις κοιτάς σαν αξιοπερίεργα", judge: "κρίνει ποια αίθουσα είναι πιο παράξενη και τι θα θες να φωτογραφίσεις" },
          person: { title: "Θάλαμος παραξενιών", short: "Άνθρωποι που όλοι έρχονται να χαζέψουν", judge: "κρίνει ποια πρόσωπα είναι πιο ασυνήθιστα και αξίζει να τα πεις στους φίλους" },
          character: { title: "Αίθουσα μυθοπλασίας", short: "Ήρωες που αξίζουν εισιτήριο", judge: "κρίνει ποιοι χαρακτήρες είναι πιο εντυπωσιακοί και αξίζουν φωτογραφία" },
          food: { title: "Μουσείο φαγητού", short: "Πιάτα που τα κοιτάς με φρίκη και θαυμασμό", judge: "κρίνει ποια πιάτα είναι πιο ασυνήθιστα και βγαίνουν καλύτερα στη φωτογραφία" },
          city: { title: "Μουσείο πόλεων", short: "Πόλεις που είναι εκθέματα από μόνες τους", judge: "κρίνει ποιες πόλεις είναι πιο ασυνήθιστες και πώς θα εκπλήξουν τους επισκέπτες" },
          country: { title: "Μουσείο χωρών", short: "Χώρες που είναι ήδη θάλαμος παραξενιών", judge: "κρίνει ποιες χώρες είναι πιο ασυνήθιστες και δίνουν τα πιο έντονα εκθέματα" },
          place: { title: "Αίθουσα θαυμάτων", short: "Μέρη που σου πέφτει το σαγόνι", judge: "κρίνει ποια μέρη είναι πιο παράξενα και φωτογενή" },
          animal: { title: "Θάλαμος σπάνιων", short: "Ζώα που δεν τα δείχνει κανένας άλλος", judge: "κρίνει ποια ζώα είναι πιο σπάνια, παράξενα και φωτογενή" },
          painting: { title: "Αίθουσα τρελής τέχνης", short: "Πίνακες που μένεις μπροστά τους με ανοιχτό στόμα", judge: "κρίνει ποιοι πίνακες είναι πιο παράξενοι και εντυπωσιακοί μαζί" },
          company: { title: "Μουσείο επιχειρήσεων", short: "Εταιρείες που η ιστορία τους είναι έκθεμα", judge: "κρίνει ποιες εταιρείες έχουν τις πιο παράξενες ιστορίες και προϊόντα" },
          club: { title: "Μουσείο γκαφών", short: "Σύλλογοι με ιστορίες που δεν τις βγάζει μυαλό", judge: "κρίνει ποιοι σύλλογοι έχουν την πιο αστεία ιστορία και ιστορίες να πεις" },
          profession: { title: "Μουσείο επαγγελμάτων", short: "Δουλειές που δεν τις πιστεύεις αν δεν τις δεις", judge: "κρίνει ποια επαγγέλματα είναι πιο ασυνήθιστα και εντυπωσιακά να τα βλέπεις" },
          invention: { title: "Αίθουσα μαραφετιών", short: "Εφευρέσεις που θέλουν βιτρίνα", judge: "κρίνει ποιες εφευρέσεις είναι πιο εντυπωσιακές και πού θα σταθεί ο κόσμος" },
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
    judge: "оценивает шок для современников и насколько посылка изменит ход истории",
    byKind: {
      film: { title: "Кино для рыцарей", short: "Что показать Средневековью на большом экране", judge: "оценивает, как фильмы шокируют зрителей прошлого и что изменят их идеи" },
      series: { title: "Сериал для инквизиции", short: "Что запустить в прошлом на всю деревню", judge: "оценивает шок для прошлого и какие идеи сериалов изменят историю" },
      person: { title: "Гости из будущего", short: "Кого забросить в Средние века", judge: "оценивает, чьи знания и влияние сильнее изменят ход истории" },
      character: { title: "Герои в прошлом", short: "Кого выпустить в Средневековье", judge: "оценивает, чьи способности и идеи сильнее перевернут прошлое" },
      food: { title: "Ужин для короля", short: "Чем накормить средневековый двор", judge: "оценивает, какие блюда шокируют прошлое и изменят земледелие и торговлю" },
      city: { title: "Город из будущего", short: "Какой город перенести на тысячу лет назад", judge: "оценивает, чьи города шокируют прошлое и чему научат их технологии" },
      country: { title: "Страна в прошлом", short: "Целую страну — на тысячу лет назад", judge: "оценивает, чьи страны своими законами и технологиями перепишут историю" },
      place: { title: "Чудо в прошлом", short: "Какое место перенести в Средневековье", judge: "оценивает, какое чудо сильнее поразит прошлое и что оно изменит" },
      animal: { title: "Зверь для прошлого", short: "Кого выпустить в средневековый лес", judge: "оценивает, какие звери шокируют прошлое и изменят хозяйство и войны" },
      painting: { title: "Картина для монахов", short: "Что повесить в средневековом храме", judge: "оценивает, какие картины шокируют прошлое и изменят искусство" },
      company: { title: "Фирма в Средневековье", short: "Какую фирму открыть в Средних веках", judge: "оценивает, какие товары и идеи компаний сильнее изменят прошлое" },
      club: { title: "Турнир для короля", short: "Кого выставить на турнир перед королём", judge: "оценивает, как клубы шокируют прошлое и изменят спорт и зрелища" },
      profession: { title: "Спецы в прошлое", short: "Кого отправить учить Средневековье", judge: "оценивает, чьи навыки сильнее ускорят науку и прогресс" },
    },
    t: {
      en: {
        title: "Send to the Past",
        short: "Pack a parcel for the Middle Ages",
        judge: "rates the shock to the people back then and how far it changes history",
        byKind: {
          film: { title: "Cinema for Knights", short: "What you screen for the Middle Ages", judge: "rates how the films shock past audiences and what their ideas would change" },
          series: { title: "Binge for the Past", short: "What you put on for the whole village", judge: "rates the shock to the past and which ideas from the shows change history" },
          person: { title: "Guests from Ahead", short: "Who you drop into the Middle Ages", judge: "rates whose knowledge and influence would change history the most" },
          character: { title: "Heroes in the Past", short: "Who you let loose in the Middle Ages", judge: "rates whose powers and ideas would turn the past upside down" },
          food: { title: "Dinner for a King", short: "What you feed a medieval court", judge: "rates which dishes would shock the past and change farming and trade" },
          city: { title: "City from the Future", short: "Which city you drop a thousand years back", judge: "rates whose cities would shock the past and what their technology would teach" },
          country: { title: "A Country Displaced", short: "A whole country, a thousand years back", judge: "rates whose countries would rewrite history with their laws and technology" },
          place: { title: "Wonder in the Past", short: "Which landmark you move to the Middle Ages", judge: "rates which wonder would stun the past most and what it would change" },
          animal: { title: "Beast for the Past", short: "What you set loose in a medieval forest", judge: "rates which animals would shock the past and change farming and warfare" },
          painting: { title: "Art for the Monks", short: "What you hang in a medieval church", judge: "rates which paintings would shock the past and change art" },
          company: { title: "Medieval Startup", short: "Which company you open in the Middle Ages", judge: "rates which products and ideas would change the past the most" },
          club: { title: "Tournament Squad", short: "Who you enter in a tournament before the king", judge: "rates how the clubs would shock the past and change sport and spectacle" },
          profession: { title: "Experts to the Past", short: "Who you send to teach the Middle Ages", judge: "rates whose skills would speed up science and progress the most" },
        },
      },
      el: {
        title: "Στείλε στο παρελθόν",
        short: "Φτιάξε ένα πακέτο για τον Μεσαίωνα",
        judge: "κρίνει το σοκ για τους ανθρώπους της εποχής και πόσο αλλάζει την ιστορία",
        byKind: {
          film: { title: "Σινεμά για ιππότες", short: "Τι θα προβάλεις στον Μεσαίωνα", judge: "κρίνει πώς σοκάρουν οι ταινίες το κοινό του παρελθόντος και τι αλλάζουν οι ιδέες τους" },
          series: { title: "Σειρά στον Μεσαίωνα", short: "Τι θα βάλεις να δει όλο το χωριό", judge: "κρίνει το σοκ για το παρελθόν και ποιες ιδέες των σειρών αλλάζουν την ιστορία" },
          person: { title: "Επισκέπτες από αύριο", short: "Ποιους θα ρίξεις στον Μεσαίωνα", judge: "κρίνει ποιανού οι γνώσεις και η επιρροή θα άλλαζαν περισσότερο την ιστορία" },
          character: { title: "Ήρωες στον Μεσαίωνα", short: "Ποιους θα αφήσεις λυτούς στον Μεσαίωνα", judge: "κρίνει ποιανού οι δυνάμεις και οι ιδέες θα ανέτρεπαν το παρελθόν" },
          food: { title: "Δείπνο για βασιλιά", short: "Τι θα σερβίρεις σε μεσαιωνική αυλή", judge: "κρίνει ποια πιάτα θα σόκαραν το παρελθόν και θα άλλαζαν τη γεωργία και το εμπόριο" },
          city: { title: "Πόλη από το μέλλον", short: "Ποια πόλη θα στείλεις χίλια χρόνια πίσω", judge: "κρίνει ποιες πόλεις θα σόκαραν το παρελθόν και τι θα δίδασκε η τεχνολογία τους" },
          country: { title: "Χώρα στο παρελθόν", short: "Μια ολόκληρη χώρα, χίλια χρόνια πίσω", judge: "κρίνει ποιες χώρες θα ξανάγραφαν την ιστορία με τους νόμους και την τεχνολογία τους" },
          place: { title: "Θαύμα στο παρελθόν", short: "Ποιο αξιοθέατο θα πάει στον Μεσαίωνα", judge: "κρίνει ποιο θαύμα θα συγκλόνιζε περισσότερο το παρελθόν και τι θα άλλαζε" },
          animal: { title: "Θηρίο στο παρελθόν", short: "Τι θα αφήσεις λυτό στο μεσαιωνικό δάσος", judge: "κρίνει ποια ζώα θα σόκαραν το παρελθόν και θα άλλαζαν τη γεωργία και τον πόλεμο" },
          painting: { title: "Τέχνη για μοναχούς", short: "Τι θα κρεμάσεις σε μεσαιωνικό ναό", judge: "κρίνει ποιοι πίνακες θα σόκαραν το παρελθόν και θα άλλαζαν την τέχνη" },
          company: { title: "Μπίζνα στον Μεσαίωνα", short: "Ποια εταιρεία θα ανοίξεις στον Μεσαίωνα", judge: "κρίνει ποια προϊόντα και ιδέες θα άλλαζαν περισσότερο το παρελθόν" },
          club: { title: "Τουρνουά για βασιλιά", short: "Ποιον θα βάλεις σε τουρνουά μπροστά στον βασιλιά", judge: "κρίνει πώς θα σόκαραν οι σύλλογοι το παρελθόν και θα άλλαζαν τον αθλητισμό" },
          profession: { title: "Ειδικοί στο παρελθόν", short: "Ποιους θα στείλεις να μάθουν στον Μεσαίωνα", judge: "κρίνει ποιανού οι δεξιότητες θα επιτάχυναν περισσότερο την επιστήμη και την πρόοδο" },
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
    judge: "оценивает бесполезность и неловкость подарка — бесит, но без жестокости",
    byKind: {
      artist: { title: "Плейлист для врага", short: "Музыка, от которой враг завоет", judge: "оценивает, чью музыку невыносимее слушать и неловко выключить" },
      film: { title: "Киновечер для врага", short: "Что заставить врага смотреть до конца", judge: "оценивает, какие фильмы скучнее и мучительнее досматривать" },
      series: { title: "Сериал для врага", short: "Что подсунуть врагу на все выходные", judge: "оценивает, какие сериалы тоскливее и дольше тянутся" },
      person: { title: "Гости для врага", short: "Кого подселить врагу на неделю", judge: "оценивает, с какими гостями неловче и дольше тянется вечер" },
      character: { title: "Соседи для врага", short: "Кого поселить врагу за стенкой", judge: "оценивает, какие соседи раздражают сильнее, но не опасны" },
      food: { title: "Ужин для врага", short: "Чем угостить врага, чтобы он загрустил", judge: "оценивает, какой ужин неловче есть и обиднее получить" },
      city: { title: "Путёвка врагу", short: "Куда отправить врага отдыхать", judge: "оценивает, какая поездка тоскливее и неудобнее" },
      country: { title: "Билет в один конец", short: "В какую страну сослать врага", judge: "оценивает, куда ссылать неудобнее и обиднее, но без опасности" },
      place: { title: "Экскурсия врагу", short: "Куда сводить врага на целый день", judge: "оценивает, какая экскурсия скучнее и утомительнее" },
      animal: { title: "Питомец для врага", short: "Кого подарить врагу в маленькую квартиру", judge: "оценивает, с каким питомцем больше хлопот и меньше радости" },
      painting: { title: "Картина врагу", short: "Что повесить врагу над диваном", judge: "оценивает, какую картину неловко повесить и жалко выбросить" },
      company: { title: "Акции для врага", short: "Чьи акции подарить врагу на память", judge: "оценивает, чьи акции бесполезнее и обесценятся быстрее" },
      club: { title: "Клуб для врага", short: "За кого заставить врага болеть", judge: "оценивает, за кого болеть больнее: поражения, скука и тоска" },
      profession: { title: "Работа для врага", short: "Кем враг будет работать до пенсии", judge: "оценивает, какая работа скучнее, бесполезнее и неловче" },
      invention: { title: "Гаджет для врага", short: "Какую штуковину вручить врагу с бантиком", judge: "оценивает, какой гаджет бесполезнее и неловче держать дома" },
    },
    t: {
      en: {
        title: "Gift for an Enemy",
        short: "Wrap up something your enemy will politely hate",
        judge: "rates how useless and awkward the gift is — annoying, never cruel",
        byKind: {
          artist: { title: "Playlist for a Foe", short: "Music that makes your enemy howl", judge: "rates whose music is hardest to sit through and awkward to switch off" },
          film: { title: "Movie Night Revenge", short: "What your enemy has to sit through", judge: "rates which films are the dullest and most painful to finish" },
          series: { title: "Series for a Foe", short: "What to hand your enemy for the weekend", judge: "rates which shows are the dreariest and drag on longest" },
          person: { title: "Houseguests", short: "Who moves in with your enemy for a week", judge: "rates which guests make the evening most awkward and longest" },
          character: { title: "Neighbours", short: "Who moves in next door to your enemy", judge: "rates which neighbours are the most annoying without being dangerous" },
          food: { title: "Dinner for a Foe", short: "What to serve your enemy to ruin the day", judge: "rates which dinner is the most awkward to eat and the most insulting to get" },
          city: { title: "Holiday Booked", short: "Where you send your enemy on holiday", judge: "rates which trip is the dreariest and most inconvenient" },
          country: { title: "One-Way Ticket", short: "Which country you exile your enemy to", judge: "rates where exile is the most inconvenient and insulting, but safe" },
          place: { title: "Day Trip Revenge", short: "Where your enemy spends the whole day", judge: "rates which tour is the dullest and most tiring" },
          animal: { title: "Pet for a Foe", short: "What you gift into their tiny flat", judge: "rates which pet is the most hassle and the least joy" },
          painting: { title: "Art for a Foe", short: "What goes up above their sofa", judge: "rates which painting is the most awkward to hang and hardest to throw out" },
          company: { title: "Shares for a Foe", short: "Whose shares you gift as a keepsake", judge: "rates whose shares are the most useless and lose value fastest" },
          club: { title: "Club for a Foe", short: "Who your enemy has to support now", judge: "rates which club hurts most to support: losses, boredom and gloom" },
          profession: { title: "Job for a Foe", short: "What your enemy does for a living now", judge: "rates which job is the dullest, most pointless and most awkward" },
          invention: { title: "Gadget for a Foe", short: "What you hand them with a bow on top", judge: "rates which gadget is the most useless and awkward to keep at home" },
        },
      },
      el: {
        title: "Δώρο στον εχθρό",
        short: "Φτιάξε ένα δώρο που θα το μισήσει ευγενικά",
        judge: "κρίνει πόσο άχρηστο και αμήχανο είναι το δώρο — εκνευρίζει χωρίς σκληρότητα",
        byKind: {
          artist: { title: "Πλεϊλίστ για εχθρό", short: "Μουσική που θα τον κάνει να ουρλιάξει", judge: "κρίνει ποια μουσική είναι πιο αβάσταχτη και άβολη να την κλείσεις" },
          film: { title: "Σινεμά-εκδίκηση", short: "Τι θα αναγκαστεί να δει μέχρι τέλους", judge: "κρίνει ποιες ταινίες είναι πιο βαρετές και βασανιστικές ως το τέλος" },
          series: { title: "Σειρά για εχθρό", short: "Τι θα του δώσεις για όλο το σαββατοκύριακο", judge: "κρίνει ποιες σειρές είναι πιο βαρετές και τραβάνε περισσότερο" },
          person: { title: "Καλεσμένοι-τιμωρία", short: "Ποιους θα του βάλεις σπίτι για μια βδομάδα", judge: "κρίνει με ποιους καλεσμένους η βραδιά είναι πιο αμήχανη και ατελείωτη" },
          character: { title: "Γείτονες-τιμωρία", short: "Ποιους θα του βάλεις τοίχο με τοίχο", judge: "κρίνει ποιοι γείτονες εκνευρίζουν περισσότερο χωρίς να είναι επικίνδυνοι" },
          food: { title: "Δείπνο για εχθρό", short: "Τι θα του σερβίρεις για να του χαλάσεις τη μέρα", judge: "κρίνει ποιο δείπνο είναι πιο άβολο να το φας και πιο προσβλητικό να το πάρεις" },
          city: { title: "Εισιτήριο-δώρο", short: "Πού θα τον στείλεις διακοπές", judge: "κρίνει ποιο ταξίδι είναι πιο βαρετό και άβολο" },
          country: { title: "Χωρίς επιστροφή", short: "Σε ποια χώρα θα τον εξορίσεις", judge: "κρίνει πού η εξορία είναι πιο άβολη και προσβλητική, αλλά ακίνδυνη" },
          place: { title: "Εκδρομή-τιμωρία", short: "Πού θα περάσει όλη του τη μέρα", judge: "κρίνει ποια ξενάγηση είναι πιο βαρετή και κουραστική" },
          animal: { title: "Κατοικίδιο-εκδίκηση", short: "Τι θα του χαρίσεις στο μικρό του σπίτι", judge: "κρίνει ποιο κατοικίδιο έχει τον περισσότερο μπελά και τη λιγότερη χαρά" },
          painting: { title: "Πίνακας για εχθρό", short: "Τι θα κρεμάσει πάνω από τον καναπέ", judge: "κρίνει ποιον πίνακα είναι πιο άβολο να κρεμάσεις και κρίμα να πετάξεις" },
          company: { title: "Μετοχές για εχθρό", short: "Ποιες μετοχές θα του χαρίσεις για ενθύμιο", judge: "κρίνει ποιες μετοχές είναι πιο άχρηστες και χάνουν αξία πιο γρήγορα" },
          club: { title: "Ομάδα για εχθρό", short: "Ποια ομάδα θα αναγκαστεί να υποστηρίζει", judge: "κρίνει ποια ομάδα πονάει πιο πολύ να υποστηρίζεις: ήττες, βαρεμάρα, μιζέρια" },
          profession: { title: "Δουλειά για εχθρό", short: "Τι δουλειά θα κάνει από δω και πέρα", judge: "κρίνει ποια δουλειά είναι πιο βαρετή, άχρηστη και άβολη" },
          invention: { title: "Μαραφέτι-δώρο", short: "Τι θα του δώσεις με φιόγκο από πάνω", judge: "κρίνει ποιο γκάτζετ είναι πιο άχρηστο και άβολο να το έχεις σπίτι" },
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
