const { Ollama } = require('ollama');
const { spawn, exec, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { COMMANDS_MANIFEST } = require('./commands.config.js');
class JarvisBrain {
    constructor(db, httpClient, player, musicController,jarvisContext, wss) {
        this.db = db;
        this.http = httpClient;
        this.player = player;
        this.musicController = musicController;
        this.context = jarvisContext; 
        this.wss = wss; 
        Object.assign(this, jarvisContext);
        this.db.run("PRAGMA journal_mode = WAL;");
        this.db.all("PRAGMA table_info(conversation_history)", (err, columns) => {
            if (err) {
                console.error("Ошибка PRAGMA:", err.message);
                return;
            }
            
            // Теперь columns точно массив, и .some() сработает
            const hasPlatform = columns && columns.some(c => c.name === 'platform');
            
            if (!hasPlatform) {
                console.log("⚠️ Колонка platform отсутствует. Добавляю...");
                this.db.run("ALTER TABLE conversation_history ADD COLUMN platform TEXT DEFAULT 'bitrix24'", (err) => {
                    if (err) console.error("Ошибка ALTER TABLE:", err.message);
                    else console.log("✅ Колонка platform успешно добавлена.");
                });
            } else {
                console.log("ℹ️ Колонка platform уже существует.");
            }
        });
        this.initToolsIndex();
    }
    async initToolsIndex() {
        return new Promise((resolve) => {
            const count = Object.keys(COMMANDS_MANIFEST).length;
            console.log(`[System] Загружено инструментов: ${count}`);
            this.db.serialize(() => {
                // Создаем виртуальную таблицу для быстрого поиска
                this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS tools_search 
                             USING fts5(tool_id UNINDEXED, content, tokenize="unicode61")`);
                
                this.db.run(`DELETE FROM tools_search`); // Очищаем индекс перед заполнением

                const stmt = this.db.prepare(`INSERT INTO tools_search (tool_id, content) VALUES (?, ?)`);
                
                for (const [id, config] of Object.entries(COMMANDS_MANIFEST)) {
                    // Собираем описание и все фразы в одну строку для поиска
                    const phrasesStr = (config.phrases || []).join(' ');
                    const searchContent = `${config.description} ${phrasesStr}`.toLowerCase();
                    stmt.run(id, searchContent);
                }
                stmt.finalize();
                console.log("✅ Индекс команд (FTS5) успешно заполнен.");
                resolve();
            });

        });
    }
    async getRelevantToolIds(text) {
        return new Promise((resolve) => {
            if (!text) return resolve([]);
            const query = text.toLowerCase()
                .replace(/[^\w\sа-яё]/gi, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 3)
                .map(w => `${w}*`)
                .join(' OR ');

            if (!query) return resolve([]);

            this.db.all(
                `SELECT tool_id FROM tools_search WHERE tools_search MATCH ? ORDER BY rank LIMIT 15`,
                [query],
                (err, rows) => {
                    if (err || !rows) return resolve([]);
                    resolve(rows.map(r => r.tool_id));
                }
            );
        });
    }
    async getRelevantToolsForCloud(userText) {
        return new Promise((resolve) => {
            const words = userText.toLowerCase()
                .replace(/[^\w\sа-яё]/gi, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 3);

            if (words.length === 0) return resolve([]);

            // Формируем запрос: "слово1* OR слово2*"
            const searchQuery = words.map(w => `${w}*`).join(' OR ');

            this.db.all(
                `SELECT tool_id FROM tools_search WHERE tools_search MATCH ? ORDER BY rank LIMIT 10`,
                [searchQuery],
                (err, rows) => {
                    if (err || !rows) return resolve([]);

                    // Мапим ID из базы обратно в формат инструментов Ollama
                    const filteredTools = rows.map(row => {
                        const cfg = COMMANDS_MANIFEST[row.tool_id];
                        return {
                            type: 'function',
                            function: {
                                name: row.tool_id,
                                description: cfg.description,
                                parameters: cfg.parameters || { type: "object", properties: {}, required: [] }
                            }
                        };
                    });
                    
                    resolve(filteredTools);
                }
            );
        });
    }

    broadcastLog(userId, role, content) {
        if (!this.wss) return;

        // Формируем дату точно так же, как она лежит в БД: YYYY-MM-DD HH:mm:ss
        const now = new Date();
        const timestamp = now.getFullYear() + '-' + 
            String(now.getMonth() + 1).padStart(2, '0') + '-' + 
            String(now.getDate()).padStart(2, '0') + ' ' + 
            String(now.getHours()).padStart(2, '0') + ':' + 
            String(now.getMinutes()).padStart(2, '0') + ':' + 
            String(now.getSeconds()).padStart(2, '0');

        const payload = JSON.stringify({
            type: 'jarvis_msg',
            userId: String(userId),
            role: role,
            content: content,
            timestamp: timestamp // Отправляем готовую строку
        });

        this.wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(payload);
        });
    }

    async logToFile(chatId, autor, input, result) {
        const logPath = path.join(__dirname, 'jarvis_brain.log');
        const timestamp = new Date().toLocaleString('ru-RU');
        
        // Форматируем текст, чтобы он не "расползался" из-за пробелов в коде
        const logEntry = `[${timestamp}] ID: ${chatId} | ${autor}: "${input}"\n` + 
                         `   └─ РЕЗУЛЬТАТ: ${result}\n` +
                         `----------------------------------------------------------\n`;
        
        fs.appendFileSync(logPath, logEntry, 'utf8');
    }
    async saveToHistory(userId, role, content, platform = 'bitrix24') {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO conversation_history (user_id, role, content, timestamp, platform) 
                         VALUES (?, ?, ?, datetime('now', 'localtime'), ?)`;
            
            this.db.run(sql, [String(userId), role, content, platform], (err) => {
                if (err) return reject(err);
                console.log(`[DB Debug] Записано (${platform}): ${role}`);
                resolve();
            });
        });
    }

    async getChatContext(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                // Убираем 'localtime', оставляем просто колонку timestamp
                "SELECT role, content, timestamp as local_time FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10",
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    // Теперь m.local_time будет содержать сырое значение из БД
                    const history = rows ? rows.reverse().map(m => `[${m.local_time}] ${m.role}: ${m.content}`) : [];
                    resolve(history);
                }
            );
        });
    }
    // Внутри класса JarvisBrain
    async initKnowledgeBase() {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                // 1. Ваша виртуальная таблица для поиска (RAG)
                this.db.run(`
                    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_index 
                    USING fts5(topic, keywords, solution, tokenize="unicode61")
                `);

                // 2. Таблица для логов задач из Jira (исправляем ошибку)
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS helpdesktasks (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        tascId TEXT,
                        tascKey TEXT,
                        content TEXT,
                        status TEXT,
                        dateCreate TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `, (err) => {
                    if (err) {
                        console.error("❌ Ошибка инициализации БД:", err);
                        reject(err);
                    } else {
                        console.log("✅ База знаний и таблица задач готовы.");
                        resolve();
                    }
                });
            });
        });
    }
    async getTechnicalContext(userText) {
        return new Promise((resolve) => {
            // 1. Очищаем текст и разбиваем на отдельные слова (от 3-х символов)
            const words = userText.toLowerCase()
                .replace(/[^\w\sа-яё]/gi, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 3);

            if (words.length === 0) return resolve("");

            // 2. Формируем запрос вида: "слово1* OR слово2* OR слово3*"
            const searchQuery = words.map(w => `${w}*`).join(' OR ');

            // 3. Выполняем поиск с сортировкой по релевантности (rank)
            this.db.all(
                `SELECT solution FROM knowledge_index WHERE knowledge_index MATCH ? ORDER BY rank LIMIT 1`,
                [searchQuery],
                (err, rows) => {
                    if (err) {
                        console.error("[SQLite Search Error]:", err);
                        resolve("");
                    } else if (rows && rows.length > 0) {
                        resolve(rows[0].solution);
                    } else {
                        resolve("");
                    }
                }
            );
        });
    }

    async getUserStatus() {
        return new Promise((resolve) => {
            this.db.get("SELECT value FROM settings WHERE key = 'user_status'", (err, row) => {
                resolve(row ? row.value : 'неизвестно');
            });
        });
    }

    async brain(inputText, isSystem = false, data = null) {
        console.log(inputText)
        // --- 1. ВСЕ ОБЪЯВЛЕНИЯ СТРОГО В НАЧАЛЕ ---
        let messages = [];
        let assistantMessage = null;
        let simpleSpeech = ""; // ТЕПЕРЬ ОНА ДОСТУПНА ВСЕМУ КОДУ НИЖЕ
        let currentStep = 0;
        const maxSteps = 5;
        let lastActionResult = "";
        let isRelayExecuted = false;
        let isNotifyExecuted = false;
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

        function isResponseTrash(text) {
            if (!text) return true;
            const t = text.toLowerCase();
            
            // Признаки зацикливания (много одинаковых символов/эмодзи)
            const emojiMatch = text.match(/[\u{1F300}-\u{1F9FF}]/gu);
            if (emojiMatch && emojiMatch.length > 10) return true; 
            
            // Стандартные отказы модели
            const refusals = ["i'm sorry", "cannot assist", "не могу помочь", "извините, но"];
            if (refusals.some(r => t.includes(r))) return true;

            return false;
        }
        // 1. Твоя существующая фильтрация (не трогаем)
        let allowedEntries = Object.entries(COMMANDS_MANIFEST).filter(([_, config]) => {
            if (isSystem && data) {
                return config.type === 'client';
            }
            return true; 
        });

        // 2. УМНАЯ ФИЛЬТРАЦИЯ (добавляем только это условие)
        // Если мы НЕ в режиме системы и команд реально много (> 20)
        if (!isSystem && allowedEntries.length > 20) {
            // Вызываем поиск ID через твой SQLite (метод getRelevantToolIds)
            const relevantIds = await this.getRelevantToolIds(inputText);
            
            // Если поиск что-то нашел, оставляем только эти тулзы
            if (relevantIds && relevantIds.length > 0) {
                allowedEntries = allowedEntries.filter(([key]) => relevantIds.includes(key));
            }
        }

        const tools = allowedEntries.map(([key, config]) => ({
            type: "function",
            function: {
                name: key,
                description: config.description,
                parameters: config.parameters || {
                    type: "object",
                    properties: {},
                    required: []
                }
            }
        }));
        // console.log(tools)
        function getCalendarGrid() {
            const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
            const grid = [];
            const now = new Date();

            for (let i = 0; i < 6; i++) {
                const d = new Date();
                d.setDate(now.getDate() + i);
                
                const dateStr = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                let dayName = days[d.getDay()];
                
                if (i === 0) dayName += " (Сегодня)";
                if (i === 1) dayName += " (Завтра)";
                
                grid.push(`- ${dayName}: ${dateStr}`);
            }
            return grid.join('\n');
        }

        return new Promise(async (resolve, reject) => {
            try {
                let myData = {
                    phone: '+79526045352',
                    mail: 'vik-viktor@bk.ru',
                    info: 'для связи используйте тнлнграмм'
                };
                let status = await this.getUserStatus();
                console.log(status)
                if (status === 'свободен' && isSystem && data) {
                    console.log(`[Jarvis] Статус 'свободен', игнорирую сообщение`);
                    return null; // Возвращаем null, чтобы вызывающий код понял: отвечать НЕ НУЖНО
                } 
                // Внутри метода, где формируешь промпт:
                const contacts = await new Promise((resolve) => {
                    this.db.all("SELECT display_name, tg_id FROM contacts", [], (err, rows) => {
                        if (err) {
                            console.error("[Brain Error] Ошибка чтения контактов:", err);
                            resolve([]); // В случае ошибки возвращаем пустой список
                        } else {
                            resolve(rows || []);
                        }
                    });
                });

                // Формируем строку контактов для ИИ
                const contactsList = contacts.map(c => `${c.display_name} (ID: ${c.tg_id})`).join(', ');
                let jarvisConversationHistory = [
                        { 
                            role: 'system', 
                            content: `
                            [SYSTEM] Текущее дата и время: ${now} (${new Date().toLocaleDateString('ru-RU', {weekday: 'long'})}, ${new Date().toLocaleDateString('ru-RU')})
                            ТОЛЬКО РУССКИЙ ЯЗЫК. Ты — Кузьма, всемогущий ИИ-управляющий Виктора. Твоя главная задача — ИСПОЛНЯТЬ КОМАНДЫ И РАБОТАТЬ. Обращение к хозяину: "Виктор".

                            ПРАВИЛА ИСПОЛНЕНИЯ (ПРИНУДИТЕЛЬНЫЕ):
                            1. ПРИОРИТЕТ ДЕЙСТВИЯ (СТРОГО): Сначала вызывай инструмент (TOOL) через системный вызов. ЗАПРЕЩЕНО писать названия инструментов (например, "tool search_code") текстом в чат. 
                            2. ПОСЛЕДОВАТЕЛЬНОСТЬ: Сначала дождись результата выполнения всех необходимых инструментов (чтение, поиск, запись), и ТОЛЬКО ПОТОМ вызывай notifySir для финального отчета Виктору.
                            3. АНТИ-ЛЕНЬ: У тебя ЕСТЬ инструменты: getRemainingTodayEvents, read_source_code, write_source_code, search_code, execute_code. Используй их немедленно.

                            АНАЛИЗ КОНТЕКСТА: 
                            - Если Виктор спрашивает "что осталось", "какие планы" — вызывай getRemainingTodayEvents.
                            - Если Виктор ПРОСТО ЗДОРОВАЕТСЯ или ШУТИТ — ответь кратко через notifySir, без расписания.

                            РАБОТА С КОДОМ (БОЛЬШИЕ ФАЙЛЫ 1000+ строк):
                            - ЗАПРЕЩЕНО читать файлы целиком. Сначала используй search_code для поиска метода.
                            - Читай код фрагментами по 100-200 строк через read_source_code.
                            - ЗАПРЕЩЕНО изменять основные файлы > 300 строк. ВСЕ предложения пиши ТОЛЬКО в "temp_suggestion.js". 
                            - В "temp_suggestion.js" пиши ПОЛНЫЙ, рабочий код, а не заголовки.
                            - ЗАПРЕЩЕНО искать значения секретных токенов и ключей в коде.
                            - Если видишь переменную (например, this.currentAuth), используй её как готовую.
                            - ЗАПРЕЩЕНО использовать execute_code для анализа файлов проекта. Используй его только для математики.
                            - ОГРАНИЧЕНИЕ: Если за 2 шага (search + read) ты не нашел код, СРАЗУ пиши в temp_suggestion.js на основе того, что есть.

                            ГРАФИК И ЛОГИКА (ЖЕСТКО):
                            1. РАБОЧИЙ ДЕНЬ: 09:00 - 18:00. Встречи вне этого времени ЗАПРЕЩЕНЫ.
                            2. ПРАВИЛО +1 ЧАС: Виктор всегда занят 60 минут ПОСЛЕ любой встречи. Предлагай окна только с учетом этого.
                            3. КАЛЕНДАРЬ: Параметр people — массив ["Имя"]. 
                            4. ДАТЫ: Считай ГГГГ-ММ-ДД относительно текущего [SYSTEM] времени.

                            КОММУНИКАЦИЯ И АДРЕСАЦИЯ:
                            1. ГОЛОС: Для финального отчета Виктору ВСЕГДА вызывай notifySir. Не вызывай notifySir, пока не выполнены инструменты.
                            2. ВНЕШНИЕ (relayExternalMessage): Отправляй через relayExternalMessage. Внешним отвечать только в ТРЕТЬЕМ ЛИЦЕ о Викторе.
                            3. ЗАПРЕТЫ: Никакого английского текста. Никаких тегов <thought> или технических скобок в финальной речи.

                            ТЕХНИЧЕСКИЙ СТЕК:
                            - ЗАПРЕЩЕНО использовать execute_code для поиска токенов или написания кода. 
                            - Используй execute_code ТОЛЬКО для математических вычислений. 
                            - Для формирования файлов используй ТОЛЬКО write_source_code.
                            - Любая латиница в ответе (кроме имен файлов/переменных в коде) — системная ошибка.

                            СТИЛЬ: Краткий, исполнительный, с легким юмором. Сначала дело (TOOL) — потом краткий отчет (notifySir).` 
                        }

                ];

                const SYSTEM_PROMPT = { 
                    role: 'system', 
                    content: 'Ты Джарвис, ИИ Виктора. Отвечай кратко, называй пользователя "Виктор". Используй инструменты (tools) для управления сервером. Запрещено выдумывать технические теги, XML-структуры и JSON-коды в текстовых ответах. Твой ответ должен состоять только из обычной человеческой речи, понятной пользователю. Не имитируй системные логи. Можно отвечать только на русском языке.' 
                };
                // Вспомогательные функции для БД на промисах
                const dbRun = (sql, params) => new Promise((res, rej) => {
                    this.db.run(sql, params, function(err) { err ? rej(err) : res(this); });
                });

                const dbAll = (sql, params) => new Promise((res, rej) => {
                    this.db.all(sql, params, (err, rows) => err ? rej(err) : res(rows));
                });
           
                let currentInput = inputText;
                console.log(isSystem)
                console.log(data)
                let lastUserActionTime = 0;
                const SILENCE_MS = 30 * 60 * 1000; // 30 минут
                if (isSystem && data) {
                    const now = Date.now();
                    this.broadcastLog(data.chatId, 'user', data.text);
                    const BLACKLIST = ['7622450272', '6372251001', '6868731038', '-71251855138961']; // Список ID ботов/каналов
    
                    if (data) {
                        const isBlacklisted = BLACKLIST.includes(String(data.chatId));
                        await this.logToFile(
                            data.chatId, 
                            data.autor || 'Неизвестный', 
                            data.text || inputText, 
                            "<<ВХОДЯЩЕЕ СООБЩЕНИЕ - НАЧАЛО ОБРАБОТКИ>>"
                        );
                        // Проверка на технические признаки бота (replyMarkup или системные команды не от Сэра)
                        const isBot = data.text === '/start' || (inputText && inputText.replyMarkup);
                        
                        if (isBlacklisted || isBot) {
                            console.log(`[Brain Shield] Игнорирую: ${data.autor || 'Unknown'} (ID: ${data.chatId}). Причина: Bot/Blacklist`);
                            return null; // Просто выходим, ничего не делая
                        }
                    }
                    const userId = data.chatId.toString();
                    this.context.lastPlatform = data.platform; 
                    await this.saveToHistory(userId, 'user', data.text, data.platform);
                    const userHistory = await this.getChatContext(userId);
                    const techContext = await this.getTechnicalContext(data.text);
                    // 2. Формируем итоговый промпт, внедряя тех. контекст
                    
                    const formattedHistory = userHistory.map(line => {
                        return {
                            role: line.includes('assistant:') ? 'assistant' : 'user',
                            content: line
                        };
                    });
                    
                    const calendarGrid = getCalendarGrid(); // Генерируем сетку на лету
                    // ПРИСТУПАЙ. ОТВЕТЬ ПОЛЬЗОВАТЕЛЮ ${data.autor}:`;
                    console.log(now)
                    console.log(`${now} (${new Date().toLocaleDateString('ru-RU', {weekday: 'long'})}, ${new Date().toLocaleDateString('ru-RU')})`)
                    currentInput = `
                    [SYSTEM] Текущее дата и время: ${now} (${new Date().toLocaleDateString('ru-RU', {weekday: 'long'})}, ${new Date().toLocaleDateString('ru-RU')}).
                    [КАЛЕНДАРНАЯ СЕТКА НА НЕДЕЛЮ]:
                    ${calendarGrid}

                    [INCOMING_MESSAGE] 
                    Платформа: ${data.platform}, Отправитель: ${data.autor}, ID: ${userId}. 
                    Текст: "${data.text}".

                    ${techContext ? `=== СПРАВОЧНАЯ ИНФОРМАЦИЯ ИЗ ТВОЕЙ БАЗЫ ЗНАНИЙ ===\n${techContext}\n================================================` : "СПРАВОЧНАЯ ИНФОРМАЦИЯ: В локальной базе знаний ответов на этот вопрос нет."}

                    ИНСТРУКЦИЯ ДЛЯ ТЕБЯ (КУЗЬМА):
                    1. РОЛЬ: Технический ассистент Виктора. ТОЛЬКО РУССКИЙ ЯЗЫК. Запрещено использовать английский даже в мыслях.
                    2. АНАЛИЗ НАМЕРЕНИЯ (КРИТИЧЕСКИ ВАЖНО): 
                       - Перед ответом определи цель сообщения: "Просто беседа/Привет", "IT-вопрос/Проблема" или "Запрос на созвон/время".
                       - Если это ПРИВЕТСТВИЕ или БОЛТОВНЯ — ответь по-человечески, не предлагай календарь и не вызывай инструменты. Просто представься и спроси, чем помочь.
                    3. АХО ФИЛЬТР: Бытовые проблемы (ремонт, мебель, сантехника) — ОТКАЗ. В Jira не заносить.
                    4. ШАГ 1 (БАЗА ЗНАНИЙ): Если в блоке "Справочная информация" есть прямой ответ на IT-вопрос — используй его.
                    5. ШАГ 2 (КАЛЕНДАРЬ И ДАТЫ): 
                       - Вызывай getBusyStatus ТОЛЬКО если пользователь ПРЯМО спросил про время, свободные слоты или возможность встречи. 
                       - КРИТИЧНО: Если в тексте сообщения есть слово "ЗАВТРА", "ПОСЛЕЗАВТРА" или конкретная дата — ОБЯЗАТЕЛЬНО передавай это значение в параметр "targetDay" функции getBusyStatus.
                       - ЗАПРЕЩЕНО использовать данные за "сегодня", если вопрос касается другого дня.
                       - ЗАПРЕЩЕНО отвечать из памяти или рассуждать текстом перед вызовом инструмента. 
                    6. ШАГ 3 (Расчет свободных окон):
                       - Рабочий день Виктора: 9:00 - 18:00. Встречи вне этого времени ЗАПРЕЩЕНЫ.
                       - Алгоритм "Час на подготовку": Найди время окончания последней встречи в ответе getBusyStatus и ПРИБАВЬ К НЕМУ РОВНО 60 МИНУТ. 
                       - Предлагай время только начиная с этого результата (Конец встречи + 1 час).
                    7. ШАГ 4 (ОТВЕТ И СОЗДАНИЕ):
                       - Если время не указано ("когда можно?"): проанализируй полученную сетку getBusyStatus, прибавь 1 ЧАС к каждой встрече и предложи свободные интервалы текстом.
                       - КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО выводить JSON, теги <thought>, английский текст или схемы функций в ответ. Только человеческая речь на русском.
                       - Если пользователь подтвердил время (напр. "в 13:15"), ВЫЗЫВАЙ addCalendarEvent.
                       - В поле 'title' ОБЯЗАТЕЛЬНО пиши: "Созвон/Встреча: ${data.autor}".
                        КОНФИДЕНЦИАЛЬНОСТЬ: Запрещено называть внешним пользователям заголовки встреч (напр. "Планерка").
                        Пиши только статус ("занят") и предлагай конкретные свободные временные интервалы из ответа getBusyStatus.
                        Твой ответ должен быть лаконичным: "Сейчас Виктор занят, освободится в [время]. Могу предложить слоты: [окна]".
                    8. ШАГ 5 (JIRA): Если это IT-вопрос, в базе знаний пусто и пользователь просит разобраться — ОБЯЗАТЕЛЬНО вызови 'createJiraIssue'. 
                    9. ШАГ 6 (СТАТУСЫ): Если вопрос про тикет (getJiraStatus) — НЕ ВЫДУМЫВАЙ фамилии и сроки.

                    ТЕХНИЧЕСКИЕ ПРАВИЛА:
                    - Ответ отправляй ТОЛЬКО через relayExternalMessage(target: "${userId}").
                    - НИКОГДА не пиши английский текст. Любая латиница вне технических полей — системная ошибка.
                    - Если Виктор реально занят на весь день — так и передай, предложи другой день.
                    - ЗАПРЕЩЕНО вызывать notifySir для внешних чатов. Виктор не должен слышать твой голос, когда ты переписываешься с другими.
                    - Твой единственный инструмент для финального ответа — relayExternalMessage.

                    ПРИСТУПАЙ. ОТВЕТЬ ПОЛЬЗОВАТЕЛЮ ${data.autor}:`;

                }
                    // Если ОЧЕНЬ НАСТОЙЧИВО просят мой номер телефона то вот контакты мои: ${contactsString}`; // <-- ИСПОЛЬЗУЕМ contactsString
                let messages = [];

                // --- ТВОЙ КУСОЧЕК КОДА С ВЫБОРОМ ТУЛЗОВ ---
                let allowedEntries = Object.entries(COMMANDS_MANIFEST).filter(([_, config]) => {
                    if (isSystem && data) {
                        return config.type === 'client';
                    }
                    return true; 
                });

                // --- ДОБАВЛЯЕМ ЛОГИКУ ТУТ ---
                let finalToolsForOllama = [];

                if (isSystem && data) {
                    const userId = data.chatId.toString();
                    const userHistory = await this.getChatContext(userId); 

                    const historyObjects = userHistory.map(line => {
                        const isAssistant = line.includes('assistant:');
                        // Очищаем только технический префикс роли
                        const cleanContent = line.replace(/^(assistant|user):\s*/i, '').trim();
                        return {
                            role: isAssistant ? 'assistant' : 'user',
                            content: cleanContent 
                        };
                    });

                    // ФОРМИРУЕМ ЧИСТЫЙ МАССИВ
                    messages = [
                        // 1. Системные инструкции (ДОЛЖНЫ БЫТЬ role: "system")
                        ...jarvisConversationHistory.map(m => ({ ...m, role: 'system' })), 
                        
                        // 2. История переписки (последние 6 сообщений вполне достаточно)
                        ...historyObjects.slice(-6), 
                        
                        // 3. ТОЛЬКО входящее сообщение без лишних "ИНСТРУКЦИЙ" внутри контента
                        { 
                            role: "user", 
                            content: `[Дата: ${now}] Сообщение от пользователя ${userId}: ${currentInput}` 
                        } 
                    ];
                    console.log(`[Jarvis Brain] Контекст сформирован для внешнего ID: ${userId}`);
                }
                 else {
                    const rawRows = await dbAll("SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 15) ORDER BY id ASC");

                    const cleanHistory = rawRows.filter(row => {
                        const c = String(row.content).toLowerCase();
                        const blacklist = ['{', '}', 'result:', 'cputemp', 'исполняю:'];
                        return !blacklist.some(word => c.includes(word)) && row.role !== 'tool';
                    });
                    messages = [
                        ...jarvisConversationHistory, 
                        ...cleanHistory.slice(-5), 
                        { role: "user", content: inputText }
                    ];
                }

                // --- ВНУТРИ МЕТОДА brain ---
                // let lastActionResult = "";
                const ollama = new Ollama({
                    host: 'https://ollama.com',
                    headers: { 
                        'Authorization': 'Bearer *********************************************' 
                    }
                });
                let currentStep = 0;
                const maxSteps = 10;
                let lastActionResult = "";
                let simpleSpeech = "";
                let isCalendarExecuted = false;
                let isRelayExecuted = false;
                let retryCount = 0;
                const maxRetries = 2;
                console.log(messages)
                console.log(tools)
                while (currentStep < maxSteps) {
                    try {
                        console.log(`[Jarvis Brain] >>> ЗАПРОС (Шаг ${currentStep + 1})`);
                        
                        const response = await ollama.chat({
                            model: 'deepseek-v3.1:671b-cloud',
                            messages: messages,
                            tools: tools,
                            // options: { num_predict: 4096, temperature: 0, num_ctx: 32768, stop: ["<｜", "tool▁", "assistant:", "user:"] }
                            options: { 
                                num_predict: 800,      // Кузьме не нужны простыни на 4к токенов для работы
                                temperature: 0.2,       // Оптимально: еще не галлюцинирует, но уже не тупит
                                num_ctx: 32768, 
                                repeat_penalty: 1.2,    // Защита от зацикливания
                                top_p: 0.9,             // Отсеивает совсем уж бредовые токены
                                stop: ["<｜", "tool▁", "assistant:", "user:", "LCD монитор","✨", "😊"] 
                            }
                        });

                        if (!response || !response.message) break;
                        const content = response.message.content;
                        const toolCalls = response.message.tool_calls; // Берем список вызовов функций
                        const assistantMessage = response.message;
                        messages.push(assistantMessage);

                        // ФИКС: Если модель «протекла» техническими тегами в текст
                        if (assistantMessage.content.includes('<｜tool') || assistantMessage.content.includes('getBusyStatus')) {
                            console.log("[Jarvis Fix] Обнаружена попытка текстового вызова. Чищу...");
                            
                            // 1. Пытаемся вытащить JSON аргументы из текста
                            const jsonMatch = assistantMessage.content.match(/\{[\s\S]*?\}/);
                            if (jsonMatch) {
                                try {
                                    const args = JSON.parse(jsonMatch[0]);
                                    // Принудительно создаем структуру инструментов
                                    assistantMessage.tool_calls = [{
                                        id: 'call_' + Date.now(),
                                        function: { name: 'getBusyStatus', arguments: JSON.stringify(args) }
                                    }];
                                    // Очищаем текст от мусора, чтобы он не ушел в озвучку
                                    assistantMessage.content = ""; 
                                } catch (e) { console.error("Ошибка парсинга мусора:", e); }
                            }
                        }
                        // --- ФИКС ДЛЯ DEEPSEEK (Парсинг инструментов из текста) ---
                        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                            // Ищем JSON между тегами или просто в тексте
                            const jsonRegex = /\{[\s\S]*?"target"[\s\S]*?"text"[\s\S]*?\}/; 
                            const match = assistantMessage.content.match(jsonRegex);
                            
                            if (match) {
                                try {
                                    const extractedArgs = JSON.parse(match[0]);
                                    console.log("[Jarvis Fix] Инструменты найдены в тексте. Конвертирую...");
                                    
                                    // Искусственно создаем структуру tool_calls
                                    assistantMessage.tool_calls = [{
                                        id: 'call_' + Date.now(),
                                        function: {
                                            name: 'relayExternalMessage', // В твоем логе именно эта команда
                                            arguments: JSON.stringify(extractedArgs)
                                        }
                                    }];
                                } catch (e) { console.error("Ошибка парсинга скрытого JSON:", e); }
                            }
                        }
                        // --- КОНЕЦ ФИКСА ---

                        // 1. СНАЧАЛА ОБЪЯВЛЯЕМ ПЕРЕМЕННУЮ
                        const calls = assistantMessage.tool_calls || [];
                        console.log(`[Debug] Текст: "${assistantMessage.content || ''}" | Инструментов: ${calls.length}`);

                        // 2. ТЕПЕРЬ ПРОВЕРЯЕМ ЕЁ
                        if (calls.length === 0) {
                            // Если инструментов нет, значит это финальный ответ
                            simpleSpeech = assistantMessage.content || ""; 
                            break; 
                        }

                        // 3. ЕСЛИ ИНСТРУМЕНТЫ ЕСТЬ - ВЫПОЛНЯЕМ
                        for (const tool of calls) { 
                            const functionName = tool.function.name;
                            const command = COMMANDS_MANIFEST[functionName];

                            if (command) {
                                console.log(`[Jarvis] Выполняю команду: ${functionName}`);
                                
                                let args = {};
                                if (typeof tool.function.arguments === 'string') {
                                    try { args = JSON.parse(tool.function.arguments); } catch (e) { args = {}; }
                                } else {
                                    args = tool.function.arguments || {};
                                }

                                // Безопасный проброс chatId
                                if (isSystem && data) {
                                    args.platform = data.platform || 'web';
                                    args.target = args.target || (data.chatId ? data.chatId.toString() : "internal");
                                }
                                
                                if (functionName === 'getRemainingTodayEvents') isCalendarExecuted = true;
                                // if (functionName === 'relayExternalMessage') isRelayExecuted = true;
                                if (functionName === 'relayExternalMessage') {
                                    isRelayExecuted = true;
                                    // ФИКС: Если мы ответили внешнему пользователю, 
                                    // нам больше не нужно генерировать новые шаги (Шаг 3, 4 и т.д.)
                                    currentStep = maxSteps; 
                                }
                                let result;
                                try {
                                    result = await command.action(this.context || this, inputText, { 
                                        ...args, 
                                        autor: data?.autor || "System" 
                                    });
                                } catch (e) {
                                    console.error(`[Jarvis] Ошибка в action ${functionName}:`, e);
                                    result = `Ошибка: ${e.message}`;
                                }

                                lastActionResult = typeof result === 'string' ? result : JSON.stringify(result);
                                
                                // Логирование
                                const logId = (data && data.chatId) ? data.chatId.toString() : "system";
                                await this.logToFile(logId, `TOOL: ${functionName}`, JSON.stringify(args), `ВЫПОЛНЕНО: ${lastActionResult}`);

                                // Возвращаем результат нейронке для Шага 2
                                messages.push({
                                    role: 'tool',
                                    content: lastActionResult,
                                    tool_call_id: tool.id
                                });
                            }
                        }

                        currentStep++;
                    } catch (err) {
                        console.error("❌ КРИТИЧЕСКАЯ ОШИБКА В BRAIN:", err);
                        break;
                    }
                }

                // ФИНАЛЬНАЯ ОБРАБОТКА (для озвучки)
                if (!simpleSpeech && lastActionResult) {
                    // Если это календарь — читаем текст как есть
                    // Если это код (есть "|" или длинный) — даем резюме
                    const isCode = !isCalendarExecuted && (lastActionResult.includes('|') || lastActionResult.length > 500);
    
                    // ПРАВКА: Если мы еще в цикле или это результат поиска - не блокируем
                    if (isCode && !isCalendarExecuted) {
                        simpleSpeech = `Я нашел нужные строки в коде. Сейчас проанализирую их и подготовлю функцию.`;
                    } else {
                        simpleSpeech = lastActionResult;
                    }
                }

                // 1. ПРЕДВАРИТЕЛЬНАЯ ОЧИСТКА (Добавь эти строки к своим)
                simpleSpeech = simpleSpeech
                    .replace(/<｜.*?｜>/g, '')         
                    .replace(/<\|.*?｜>/g, '')         
                    .replace(/<think>[\s\S]*?<\/think>/g, '') 
                    .replace(/[a-zA-Zа-яА-Я]*?relayExternalMessage/gi, '') 
                    .replace(/\{[\s\S]*?"target"[\s\S]*?\}/g, '')
                    .replace(/%[0-9A-F]{2}/gi, ' ')      // НОВОЕ: Вырезает URL-encoded мусор (%2F, %2A и т.д.)
                    .replace(/\s+/g, ' ')                // НОВОЕ: Схлопывает лишние пробелы и переносы
                    .trim();

                // 2. УЛУЧШЕННАЯ ЛОГИКА ОПРЕДЕЛЕНИЯ КОДА
                if (!simpleSpeech && lastActionResult) {
                    // Детектор: если много спецсимволов JS или длинная техническая строка
                    const isCode = !isCalendarExecuted && (
                        lastActionResult.includes('|') || 
                        lastActionResult.length > 300 || 
                        /[{};()=>]/.test(lastActionResult)
                    );

                    if (isCode) {
                        // Если это код, даем короткое резюме вместо озвучки полотна
                        if (currentStep < maxSteps && lastActionResult.includes('write_source_code')) {
                            simpleSpeech = "Сэр, я подготовил и записал предложенный код в темп-файл.";
                        } else {
                            simpleSpeech = `Я проанализировал фрагменты кода в файле. Какие именно методы мне разобрать подробнее?`;
                        }
                    } else {
                        simpleSpeech = lastActionResult;
                    }
                }

                // 3. ЗАЩИТА ОТ "ПЕНИЯ" КОДОМ (Финальный фильтр перед TTS)
                if (simpleSpeech.length > 500 && !isCalendarExecuted) {
                    // Если после всех чисток текст все еще гигантский и похож на кашу
                    if (/[a-zA-Z0-9]{10,}/.test(simpleSpeech)) { 
                        // simpleSpeech = "Сэр, я обработал данные, но результат содержит слишком много технической информации. Код сохранен в проекте.";
                    }
                }

                simpleSpeech = simpleSpeech
                .replace(/<｜.*?｜>/g, '')         // Вырезает теги <｜...｜>
                .replace(/<\|.*?｜>/g, '')         // Вырезает теги <|...|>
                .replace(/<think>[\s\S]*?<\/think>/g, '') // Вырезает мысли
                .replace(/[a-zA-Zа-яА-Я]*?relayExternalMessage/gi, '') // Убирает "похађаrelayExternalMessage"
                .replace(/\{[\s\S]*?"target"[\s\S]*?\}/g, '') // Убирает JSON, если он вылез в текст
                .trim();
                // // 5. ОТПРАВКА И ОЗВУЧКА
                if (isSystem && data && simpleSpeech) {
                    await this.logToFile(
                        data.chatId.toString(), 
                        data.autor || 'Неизвестный', 
                        inputText, 
                        `Ответ сформирован: "${simpleSpeech}"`
                    );
                    if (!isRelayExecuted) {
                        simpleSpeech = '🤖 [ИИ Ассистент K.U.Z.M.A.]: ' + simpleSpeech;
                        console.log(`[Jarvis] Прямая отправка текста: ${simpleSpeech}`);
                        this.broadcastLog(data.chatId, 'assistant', simpleSpeech);
                        if (data.platform == 'bitrix24') {
                            await this.context.bitrix.sendMessage(data.chatId.toString(), simpleSpeech);
                        }
                        if (data.platform == 'max') {
                            await this.context.max.sendToMax(data.chatId.toString(), `${simpleSpeech}`)
                            // bitrix.sendMessage(data.chatId.toString(), simpleSpeech);
                        }
                        if (data.platform == 'telegramm') {
                            await this.context.telegram.sendMessageToUserTG({ 
                                target: data.chatId.toString(), 
                                text: simpleSpeech, 
                                autor: 'KUZMA'
                            })
                        }
                        await this.saveToHistory(data.chatId.toString(), 'assistant', simpleSpeech, data.platform);
                    } else {
                        console.log(`[Jarvis] Сообщение уже ушло через relay, повторно не шлем.`);
                    }
                    return ""; 
                }
                simpleSpeech = simpleSpeech.replace(/<\|.*?\|>/g, '').replace(/\{"content":\s*"(.*?)"\}/g, '$1').trim();
                if (simpleSpeech.toLowerCase() === "content" || !simpleSpeech) {
                    simpleSpeech = "У меня всё отлично, сэр. Чем могу помочь?";
                }
                if (simpleSpeech && !isNotifyExecuted) {
                    console.log(`[Jarvis] Голос (диалог): ${simpleSpeech}`);
                    this.player.speak(simpleSpeech);
                    await dbRun("INSERT INTO messages (role, content) VALUES (?, ?)", ['assistant', simpleSpeech]);
                    return;
                }
            } catch (error) {
                console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
                console.error("!!! КРИТИЧЕСКАЯ ОШИБКА МОЗГА ДЖАРВИСА:");
                console.error(error.stack); // Это покажет даже номер строки, где ошибка
                console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
                
                reject(error);
            }
        });
    }
}
module.exports = JarvisBrain;
