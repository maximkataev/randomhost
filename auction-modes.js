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
      food: { title: "Меню ужина", short: "Собери ужин, который работает целиком", judge: "оценивает гастрономическую логику и баланс меню" },
      city: { title: "Маршрут мечты", short: "Поездка, которую захочется повторить", judge: "смотрит на впечатления и логистику маршрута" },
      country: { title: "Кругосветка", short: "Собери маршрут вокруг света", judge: "смотрит на впечатления и логистику маршрута" },
      place: { title: "Тур по чудесам", short: "Места, ради которых стоит лететь", judge: "оценивает впечатления и логистику тура" },
      animal: { title: "Зоопарк мечты", short: "Собери тех, на кого пойдут смотреть", judge: "оценивает зрелищность и разнообразие зоопарка" },
      painting: { title: "Частная галерея", short: "Коллекция, которой можно хвастаться", judge: "оценивает ценность и цельность коллекции" },
      company: { title: "Инвестпортфель", short: "Собери портфель, который вырастет", judge: "оценивает стоимость, перспективы и диверсификацию" },
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
          food: { title: "Dinner Menu", short: "Build a dinner that works as a whole", judge: "judges the culinary logic and the balance of the menu" },
          city: { title: "Dream Trip", short: "A trip you would book all over again", judge: "looks at the experiences and whether the route actually works" },
          country: { title: "Round the World", short: "Plot a route all the way around the globe", judge: "looks at the experiences and whether the route actually works" },
          place: { title: "Wonders Tour", short: "Places worth getting on a plane for", judge: "judges the experiences and whether the tour holds up" },
          animal: { title: "Dream Zoo", short: "Gather the animals people queue up for", judge: "judges how spectacular and varied the zoo is" },
          painting: { title: "Private Gallery", short: "A collection worth bragging about", judge: "judges the value and the coherence of the collection" },
          company: { title: "Investment Portfolio", short: "Build a portfolio that only goes up", judge: "weighs value, upside and diversification" },
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
          food: { title: "Μενού δείπνου", short: "Φτιάξε ένα δείπνο που στέκει ολόκληρο", judge: "κρίνει τη γαστρονομική λογική και την ισορροπία του μενού" },
          city: { title: "Ταξίδι των ονείρων", short: "Ένα ταξίδι που θα θες να το ξανακάνεις", judge: "κοιτάζει τις εμπειρίες και το αν βγαίνει η διαδρομή" },
          country: { title: "Γύρος του κόσμου", short: "Φτιάξε μια διαδρομή γύρω από τον κόσμο", judge: "κοιτάζει τις εμπειρίες και το αν βγαίνει η διαδρομή" },
          place: { title: "Τουρ στα θαύματα", short: "Μέρη που αξίζουν το αεροπλάνο", judge: "κρίνει τις εμπειρίες και το αν βγαίνει το τουρ" },
          animal: { title: "Ιδανικός ζωολογικός", short: "Μάζεψε ζώα που αξίζουν την ουρά στο ταμείο", judge: "κρίνει το θέαμα και την ποικιλία του ζωολογικού" },
          painting: { title: "Ιδιωτική γκαλερί", short: "Μια συλλογή για να καμαρώνεις", judge: "κρίνει την αξία και τη συνοχή της συλλογής" },
          company: { title: "Χαρτοφυλάκιο", short: "Φτιάξε ένα χαρτοφυλάκιο που ανεβαίνει", judge: "ζυγίζει αξία, προοπτικές και διασπορά" },
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
    judge: "ищет самый нелепый и несочетаемый набор {items}",
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
        judge: "looks for the most absurd, most mismatched set of {items}",
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
        judge: "ψάχνει το πιο παράλογο και αταίριαστο σετ από {items}",
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
    short: "Собери банду из {items} для захвата мира",
    kinds: ["character", "person", "animal", "artist", "club", "company", "profession"],
    what: "команда суперзлодеев для захвата мира",
    criteria: "угроза миру, зловещая харизма, взаимное усиление участников банды",
    prompt:
      "Оцени, насколько набор годится в злодейскую лигу: кто наводит ужас, кто отвечает за коварный план, " +
      "кто просто харизматичный псих. Милые и безобидные участники — минус, если только они не пугают своей милотой.",
    judge: "оценивает, чья банда из {items} страшнее и сработаннее",
    t: {
      en: {
        title: "Supervillain League",
        short: "Assemble a gang of {items} to take over the world",
        judge: "judges whose gang of {items} is scarier and better drilled",
      },
      el: {
        title: "Λίγκα σούπερ κακών",
        short: "Μάζεψε συμμορία από {items} για να κατακτήσεις τον κόσμο",
        judge: "κρίνει ποια συμμορία από {items} είναι πιο τρομακτική",
      },
    },
  },
  {
    id: "apocalypse",
    icon: "☢️",
    title: "Пережить апокалипсис",
    short: "Набор {items}, с которым переживёшь конец света",
    // Картины/музыканты/кино/сериалы для выживания бесполезны одинаково — судья ставит всем
    // низкие оценки и ранжирует ровно как в обычном задании, то есть выбор ни на что не влияет.
    // У профессий базовая цель и так «экипаж для выживания» — вышло бы два тайла с одной целью.
    notKinds: ["painting", "artist", "film", "series", "profession"],
    what: "набор для выживания после конца света",
    criteria: "практическая польза, живучесть, способность прокормить и защитить",
    prompt: "Оценивай холодно и практично: что реально поможет выжить, а что окажется бесполезным грузом.",
    judge: "считает, чей набор {items} дольше протянет после конца света",
    t: {
      en: {
        title: "Apocalypse Survival",
        short: "A set of {items} that gets you through the end of the world",
        judge: "works out whose set of {items} lasts longest after the end of the world",
      },
      el: {
        title: "Μετά την αποκάλυψη",
        short: "Ένα σετ από {items} που σε βγάζει από το τέλος του κόσμου",
        judge: "υπολογίζει ποιο σετ από {items} κρατάει περισσότερο μετά το τέλος",
      },
    },
  },
  {
    id: "party",
    icon: "🎉",
    title: "Вечеринка года",
    short: "Вечеринка из {items}, от которой будет весело",
    what: "вечеринка, на которую все захотят попасть",
    criteria: "веселье, неожиданность, атмосфера, о чём будут вспоминать год",
    prompt: "Скучное — минус, даже если дорогое и статусное. Важнее всего, будет ли весело.",
    judge: "выбирает, у кого вечеринка из {items} получилась веселее",
    t: {
      en: {
        title: "Party of the Year",
        short: "A party of {items} that everyone wants in on",
        judge: "picks whose party of {items} turned out more fun",
      },
      el: {
        title: "Πάρτι της χρονιάς",
        short: "Ένα πάρτι από {items} που θα ανάψει το κέφι",
        judge: "διαλέγει ποιανού το πάρτι από {items} έχει την πιο πολλή πλάκα",
      },
    },
  },
  {
    id: "museum",
    icon: "🏛️",
    title: "Музей странностей",
    short: "Экспозиция из {items}, на которую придут поглазеть",
    what: "экспозиция музея странного и удивительного",
    criteria: "необычность, зрелищность, желание сфотографировать и показать друзьям",
    prompt: "Ценится странность и зрелищность, а не ценность или качество. Предсказуемое и обыденное — низкая оценка.",
    judge: "ищет самую диковинную экспозицию из {items}",
    t: {
      en: {
        title: "Museum of Oddities",
        short: "An exhibition of {items} people show up just to gawk at",
        judge: "hunts for the weirdest exhibition of {items}",
      },
      el: {
        title: "Μουσείο παραξενιών",
        short: "Μια έκθεση από {items} που θα έρθουν να χαζέψουν",
        judge: "ψάχνει την πιο αλλόκοτη έκθεση από {items}",
      },
    },
  },
  {
    id: "timemachine",
    icon: "⏳",
    title: "Отправить в прошлое",
    short: "Набор {items}, который сильнее изменит историю",
    // У изобретений базовая цель и так «набор, который берём в прошлое» — дубль.
    // На музыкантах задание не различает составы: ранжирование выходит тем же, что в обычном.
    notKinds: ["invention", "artist"],
    what: "груз для машины времени в Средневековье",
    criteria: "насколько перевернёт ход истории, шок для современников, последствия",
    prompt: "Оценивай размах последствий: что произведёт эффект разорвавшейся бомбы, а что средневековье просто не заметит.",
    judge: "измеряет, чей набор {items} сильнее перекроит историю",
    t: {
      en: {
        title: "Send to the Past",
        short: "A set of {items} that changes history the most",
        judge: "measures whose set of {items} rewrites history hardest",
      },
      el: {
        title: "Στείλε στο παρελθόν",
        short: "Ένα φορτίο από {items} που θα αλλάξει την ιστορία",
        judge: "μετράει ποιανού το φορτίο από {items} αλλάζει την ιστορία",
      },
    },
  },
  {
    id: "gift",
    icon: "🎁",
    title: "Подарок врагу",
    short: "Набор {items}, которому враг точно не обрадуется",
    what: "издевательский подарочный набор для недруга",
    criteria: "неловкость, бесполезность, способность испортить настроение, но без жестокости",
    prompt: "Оценивай изящество издёвки: подарок должен быть формально приличным, но обидно бесполезным. Прямая грубость — минус.",
    judge: "выбирает самый изощрённо-бесполезный подарок из {items}",
    t: {
      en: {
        title: "Gift for an Enemy",
        short: "A set of {items} your enemy definitely will not enjoy",
        judge: "picks the most elegantly useless gift made of {items}",
      },
      el: {
        title: "Δώρο στον εχθρό",
        short: "Ένα σετ από {items} που σίγουρα δεν θα του αρέσει",
        judge: "διαλέγει το πιο επιδέξια άχρηστο δώρο από {items}",
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
