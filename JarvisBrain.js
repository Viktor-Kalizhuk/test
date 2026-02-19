const { Ollama } = require('ollama');
const { spawn, exec, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { COMMANDS_MANIFEST } = require('./commands.config.js');
class JarvisBrain {
    constructor(db, httpClient, player, musicController,jarvisContext ) {
        this.db = db;
        this.http = httpClient;
        this.player = player;
        this.musicController = musicController;
        this.context = jarvisContext; 
        this.db.run("PRAGMA journal_mode = WAL;");
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
    async saveToHistory(userId, role, content) {
        return new Promise((resolve, reject) => {
            this.db.run(
                "INSERT INTO conversation_history (user_id, role, content) VALUES (?, ?, ?)",
                [userId, role, content],
                (err) => err ? reject(err) : resolve()
            );
        });
    }

    async getChatContext(userId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                "SELECT role, content FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10",
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows ? rows.reverse() : []);
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
        // --- 1. ВСЕ ОБЪЯВЛЕНИЯ СТРОГО В НАЧАЛЕ ---
        let messages = [];
        let assistantMessage = null;
        let simpleSpeech = ""; // ТЕПЕРЬ ОНА ДОСТУПНА ВСЕМУ КОДУ НИЖЕ
        let currentStep = 0;
        const maxSteps = 5;
        let lastActionResult = "";
        let isRelayExecuted = false;
        let isNotifyExecuted = false;

        // 2. Подготовка контекста (myData и прочее)
        // const tools = Object.entries(COMMANDS_MANIFEST).map(([key, config]) => ({
        //     type: "function",
        //     function: {
        //         name: key,
        //         description: config.description,
        //         parameters: config.parameters || {
        //             type: "object",
        //             properties: {},
        //             required: []
        //         }
        //     }
        // }));
        // 1. Определяем, какие инструменты разрешены
        const allowedEntries = Object.entries(COMMANDS_MANIFEST).filter(([_, config]) => {
            // Если это внешняя система, берем только 'client'. В остальных случаях — все.
            if (isSystem && data) {
                return config.type === 'client';
            }
            return true; 
        });

        // 2. Формируем массив для LLM
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
                        content: `для общения разрешен только русский язык. Ты — Джарвис, ИИ Виктора. Твоя цель — вызывать инструменты (tools) для команд Виктора.
                        Если Виктор просит добавить функцию, исправить код или проанализировать: сначала прочитай текущий файл (read_source_code).
                        Напиши исправленный или новый код и сохрани его (write_source_code).
                        Если ты нашел ошибки, ЗАПРЕЩЕНО перечислять их текстом. Сразу вызывай write_source_code с исправленным текстом всего файла. Сначала исправляй — потом докладывай.
                        ПРАВИЛА ИНСТРУМЕНТОВ:
                        1. Встречи: Для планирования вызывай addCalendarEvent. Передавай имена участников в параметр people ОБЯЗАТЕЛЬНО массивом: ["Имя"].
                        2. Сообщения: Для отправки ВСЕГДА вызывай relayExternalMessage.
                        3. Голос: Чтобы ответить Виктору вслух, вызывай notifySir.
                        ТЫ ИМЕЕШЬ ДОСТУП К ИСПОЛНЕНИЮ КОДА:
                        - Если Виктор просит сложную математику, анализ текста или работу с файлами — пиши JS код и вызывай execute_code.
                        - Твой код запускается в среде Node.js.
                        - Всегда выводи результат через console.log, иначе ты его не увидишь.
                        
                        ЛОГИКА АДРЕСАЦИИ (КРИТИЧНО):
                        - Если пришло сообщение [SYSTEM_NOTIFICATION] с [ID: 12345], отвечай только через relayExternalMessage с target: '12345'.
                        - Имя в поле target (например, "жене", "Егору") — это закон. Не искать контакты, не переспрашивать ID. Система разберется сама.
                        - Если Виктор сказал "Скажи [Имя]", отправляй через relayExternalMessage(target="[Имя]").
                        
                        СТИЛЬ:
                        - Кратко, официально, обращение "Виктор".
                        - Никаких рассуждений, XML-тегов или JSON в тексте ответа. Только вызов функций через API.
                        Допускается тонкий юмор в стиле ассистента Старка, если это не мешает краткости` 
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
                if (isSystem && data) {
                    const BLACKLIST = ['7622450272', '6372251001']; // Список ID ботов/каналов
    
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
                    await this.saveToHistory(userId, 'user', data.text);
                    const userHistory = await this.getChatContext(userId);
                    
                    currentInput = `[INCOMING_MESSAGE]
                    Платформа: ${data.platform}, 
                    Отправитель: ${data.autor}, 
                    ID пользователя: ${userId}. 
                    Текст: "${data.text}".

                    История переписки с ЭТИМ пользователем:
                    ${userHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

                    ИНСТРУКЦИЯ ДЛЯ ТЕБЯ (ДЖАРВИС):
                    1. Это сообщение НЕ от Виктора. Это сообщение ИЗВНЕ.
                    2. Твой ответ должен уйти ТОЛЬКО в мессенджер через функцию relayExternalMessage (target: "${userId}").
                    3. ЗАПРЕЩЕНО использовать notifySir для ответа на этот вопрос.
                    4. Отвечай от имени ассистента Виктора. Будь вежлив с ${data.autor}.
                    ЗАПРЕЩЕНО читать показывать и изменять код, в функции секретаря это не входит...`;
                }
                    // Если ОЧЕНЬ НАСТОЙЧИВО просят мой номер телефона то вот контакты мои: ${contactsString}`; // <-- ИСПОЛЬЗУЕМ contactsString
                let messages = [];
                // console.log(tools)
                // return true
                if (isSystem && data) {
                    // --- ВНЕШНИЙ МЕССЕНДЖЕР ---
                    // Мы НЕ берем общую историю из БД (rawRows). 
                    // Мы берем ТОЛЬКО историю этого конкретного человека (userHistory)
                    const userId = data.chatId.toString();
                    const userHistory = await this.getChatContext(userId); // Твой метод получения истории по ID

                    messages = [
                        ...jarvisConversationHistory, // Системный промпт
                        ...userHistory.slice(-5),     // История этого чата
                        { role: "user", content: currentInput } // СТРОГО один объект с инструкцией
                    ];
                    
                    console.log(`[Jarvis Brain] Контекст сформирован для внешнего ID: ${userId}`);

                } else {
                    // --- ГОЛОСОВОЕ УПРАВЛЕНИЕ (СЭР) ---
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
                let lastActionResult = "";
                const ollama = new Ollama({
                    host: 'https://ollama.com',
                    headers: { 
                        'Authorization': 'Bearer db96c3e0b33f459f8c0b8fe10acfd00c.lEGugu4Ov0ldvXGzXE5Nkekp' 
                    }
                });
                // --- НАЧАЛО АВТОНОМНОГО ЦИКЛА (ДЛЯ ЧТЕНИЯ И ЗАПИСИ) ---
                let currentStep = 0;
                const maxSteps = 10; 
                let assistantMessage = null; // Объявляем ЗАРАНЕЕ для области видимости
                let isRelayExecuted = false;
                const uniqueCalls = [];
                let simpleSpeech = "";

                while (currentStep < maxSteps) {
                    try {
                        console.log(`[Jarvis Brain] Шаг ${currentStep + 1}. История: ${messages.length}`);
                        
                        const response = await ollama.chat({
                            model: 'deepseek-v3.1:671b-cloud',
                            messages: messages,
                            tools: tools,
                            options: { 
                                num_predict: 4096, 
                                temperature: 0,
                                num_ctx: 32768 // Даем больше места для кода
                            }
                        });
                        if (!response || !response.message) break;
                        
                        const assistantMessage = response.message;
                        messages.push(assistantMessage); // Сохраняем вызов в историю

                        const calls = assistantMessage.tool_calls || [];
                        if (assistantMessage.content && assistantMessage.content.includes('```json')) {
                            const jsonMatch = assistantMessage.content.match(/```json\s*([\s\S]*?)\s*```/);
                            if (jsonMatch) {
                                try {
                                    const fakeArgs = JSON.parse(jsonMatch[1]); // Берем первую группу захвата
                                    if (fakeArgs.text && fakeArgs.target) {
                                        console.log("[Jarvis Fix] Принудительная отправка из Markdown JSON");
                                        const result = await COMMANDS_MANIFEST.relayExternalMessage.action(this.context || this, inputText, { 
                                            ...fakeArgs, 
                                            autor: "J.A.R.V.I.S." // Принудительно ставим имя бота
                                        });
                                        isRelayExecuted = true;
                                        simpleSpeech = typeof result === 'string' ? result : "Отправлено через фикс";
                                        break; // Выходим из цикла, дело сделано
                                    }
                                } catch (e) { console.error("Ошибка парсинга 'костыльного' JSON:", e); }
                            }
                        }
                        if (calls.length === 0) {
                            simpleSpeech = assistantMessage.content || "";
                            break; 
                        }

                        // Итерируемся по вызовам. Важно: используем имя 'tool' здесь
                        for (const tool of calls) { 
                            const functionName = tool.function.name;
                            const command = COMMANDS_MANIFEST[functionName];

                            if (command) {
                                console.log(`[Jarvis] Выполняю команду: ${functionName}`);
                                
                                let args = {};
                                // Парсим аргументы, если они пришли строкой
                                if (typeof tool.function.arguments === 'string') {
                                    try { args = JSON.parse(tool.function.arguments); } catch (e) { args = {}; }
                                } else {
                                    args = tool.function.arguments || {};
                                }

                                if (isSystem && data) {
                                    args.platform = data.platform;
                                    args.target = args.target || data.chatId.toString();
                                }
                                
                                if (functionName === 'relayExternalMessage') isRelayExecuted = true;

                                let result;
                                try {
                                    // Вызываем твой манифест
                                    result = await command.action(this.context || this, inputText, { 
                                        ...args, 
                                        autor: data?.autor 
                                    });
                                } catch (e) {
                                    console.error(`[Jarvis] Ошибка в action ${functionName}:`, e);
                                    result = `Ошибка: ${e.message}`;
                                }

                                lastActionResult = typeof result === 'string' ? result : JSON.stringify(result);
                                await this.logToFile(
                                    data.chatId.toString(), 
                                    `TOOL: ${functionName}`, 
                                    JSON.stringify(args), 
                                    `ВЫПОЛНЕНО: ${lastActionResult}`
                                );
                                // ОБЯЗАТЕЛЬНО отправляем результат обратно нейронке
                                messages.push({
                                    role: 'tool',
                                    content: lastActionResult,
                                    tool_call_id: tool.id // Теперь переменная 'tool' определена выше в 'for'
                                });

                            } else {
                                console.warn(`[Jarvis] Команда ${functionName} не найдена.`);
                                messages.push({
                                    role: 'tool',
                                    content: "Ошибка: Команда не найдена в системе.",
                                    tool_call_id: tool.id
                                });
                            }
                        }
                        if (currentStep === 1 && lastActionResult.length > 1000) {
                            messages.push({
                                role: 'user',
                                content: "Я вижу код. Теперь просто проанализируй его и выпиши ошибки, не вызывай больше инструментов."
                            });
                        }

                        currentStep++;
                    } catch (err) {
                        console.error("❌ Ошибка в цикле Brain:", err.message);
                        break;
                    }
                }
                // 4. ФИНАЛЬНАЯ ОБРАБОТКА (ВНЕ ЦИКЛА)
                // simpleSpeech = simpleSpeech.replace(/<\|.*?\|>/g, '').trim();
                // simpleSpeech = simpleSpeech.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<\|.*?\|>/g, '').trim();
                simpleSpeech = simpleSpeech
                .replace(/<think>[\s\S]*?<\/think>/g, '') // Убираем мысли
                .replace(/<\|.*?\|>/g, '')                // Убираем токены
                .replace(/^ronger/i, '')                  // Убираем этот странный префикс
                .trim();


                // Улучшенная логика: если ИИ не выдал текст (например, застрял на чтении файла)
                if (!simpleSpeech && lastActionResult) {
                    // Проверяем, не является ли результат команды куском кода (содержит номера строк или слишком длинный)
                    const isCode = lastActionResult.includes('|') || lastActionResult.length > 300;
                    
                    if (isCode) {
                        // Если это код, не озвучиваем его, а просим продолжить или даем резюме
                        simpleSpeech = `Я просмотрел часть файла ${currentStep < maxSteps ? "" : "(достигнут лимит шагов)"}. Какие именно методы в этом фрагменте мне проанализировать подробнее?`;
                    } else {
                        // Если это короткий ответ (например, "Файл не найден" или "Ок"), оставляем как есть
                        simpleSpeech = lastActionResult;
                    }
                }

                if (!simpleSpeech) {
                    await this.logToFile(
                        data?.chatId || 'SYSTEM',
                        data?.autor || 'SYSTEM',
                        inputText,
                        `КРИТИЧЕСКИЙ ПРОПУСК: Текст ответа пуст. Последнее действие: ${lastActionResult}`
                    );
                }

                // Если всё равно пусто, но мы прошли все шаги
                if (!simpleSpeech && currentStep >= maxSteps) {
                    simpleSpeech = "Анализ файла занимает много времени. Мне продолжить изучение следующих строк?";
                }

                // 5. ОТПРАВКА И ОЗВУЧКА
                if (isSystem && data && simpleSpeech) {
                    await this.logToFile(
                        data.chatId.toString(), 
                        data.autor || 'Неизвестный', 
                        inputText, 
                        `Ответ сформирован: "${simpleSpeech}"`
                    );
                    if (!isRelayExecuted) {
                        console.log(`[Jarvis] Прямая отправка текста: ${simpleSpeech}`);
                        await this.context.bitrix.sendMessage(data.chatId.toString(), simpleSpeech);
                    } else {
                        console.log(`[Jarvis] Сообщение уже ушло через relay, повторно не шлем.`);
                    }
                    // 1. Сначала сохраняем в историю БД, чтобы getChatContext увидел это при следующем запросе
                    // await this.saveToHistory(data.chatId.toString(), 'assistant', simpleSpeech);
                    // console.log(`[Jarvis] Ответ для внешнего пользователя ${data.chatId.toString()} сохранен в БД.`);
                    // // Для Bitrix/Telegram отправляем текст полностью
                    // await this.context.bitrix.sendMessage(data.chatId.toString(), simpleSpeech);
                    return ""; 
                }
                if (!simpleSpeech && lastActionResult) {
                    simpleSpeech = "Я выполнил запрос. Вот что получилось: " + lastActionResult;
                }
                if (simpleSpeech && !isSystem) {
                    // Для голосового помощника
                    console.log(`[Jarvis] Озвучиваю: ${simpleSpeech}`);
                    
                    // Если ответ слишком длинный для голоса (больше 1000 симв), озвучиваем только начало
                    const voiceText = simpleSpeech.length > 1000 
                        ? simpleSpeech.substring(0, 300) + "... и так далее. Полный отчет в консоли." 
                        : simpleSpeech;

                    this.player.speak(voiceText);
                    
                    // В базу сохраняем полный текст для истории
                    await this.db.run("INSERT INTO messages (role, content) VALUES (?, ?)", ['assistant', simpleSpeech]);
                }

                return simpleSpeech;

                // console.log("--- ЧИСТАЯ ПАМЯТЬ ДЛЯ ИИ ---");
                // console.log(JSON.stringify(messages, null, 2));

                // const ollama = new Ollama({
                //     host: 'https://ollama.com',
                //     headers: { 
                //         'Authorization': 'Bearer db96c3e0b33f459f8c0b8fe10acfd00c.lEGugu4Ov0ldvXGzXE5Nkekp' 
                //     }
                // });
                // const response = await ollama.chat({
                //     model: 'deepseek-v3.1:671b-cloud',
                //     messages: messages,
                //     tools: tools,
                //     options: { 
                //         num_predict: 128, // Не даем ей генерировать длинные простыни текста
                //         stop: ["<|thought|>", "Explanation:"] // Прерываем галлюцинации
                //     },

                // });
                // let assistantMessage = response.message;
                // const calls = assistantMessage.tool_calls || [];
                // let isNotifyExecuted = false;
                // let isRelay = false;
                // if (calls.length > 0) {
                //     const uniqueCalls = [];
                //     const seenCalls = new Set();
                //     for (const call of calls) {
                //         const callKey = `${call.function.name}-${JSON.stringify(call.function.arguments)}`;
                //         if (!seenCalls.has(callKey)) {
                //             seenCalls.add(callKey);
                //             uniqueCalls.push(call);
                //         }
                //     }
                //     console.log(`[Jarvis Brain] Инструменты: ${uniqueCalls.map(c => c.function.name).join(', ')}`);
                //     messages.push(assistantMessage);
                //     let lastActionResult = "";
                //     let isRelayExecuted = false; 
                //     for (const tool of uniqueCalls) {
                //         const functionName = tool.function.name;
                //         const command = COMMANDS_MANIFEST[functionName];
                //         if (command) {
                //             let args = {};
                //             if (typeof tool.function.arguments === 'string') {
                //                 try { args = JSON.parse(tool.function.arguments); } catch (e) { args = {}; }
                //             } else {
                //                 args = tool.function.arguments || {};
                //             }
                //             if (isSystem && data) {
                //                 args.platform = data.platform;
                //                 args.target = args.target || data.chatId.toString();
                //             }
                //             if (functionName === 'relayExternalMessage') isRelayExecuted = true;
                //             const result = await command.action(this.context || this, inputText, { 
                //                 ...args, 
                //                 autor: data?.autor 
                //             });
                //             lastActionResult = typeof result === 'string' ? result : "";
                //             messages.push({
                //                 role: 'tool',
                //                 content: JSON.stringify(result),
                //                 tool_call_id: tool.id,
                //                 name: functionName
                //             });
                //         }
                //     }
                //     if (isSystem && isRelayExecuted) {
                //         console.log("[Jarvis Brain] Ответ в мессенджер отправлен. Голос для системы заблокирован.");
                //         return ""; 
                //     }
                //     const finalResponse = await ollama.chat({
                //         model: 'deepseek-v3.1:671b-cloud',
                //         messages: messages
                //     });
                //     let finalSpeech = finalResponse.message.content || "";
                //     if (finalSpeech.includes('{')) {
                //         try {
                //             const jsonMatch = finalSpeech.match(/\{.*\}/s);
                //             if (jsonMatch) {
                //                 const parsed = JSON.parse(jsonMatch[0]);
                //                 finalSpeech = parsed.parameters?.text || parsed.parameters?.search || parsed.text || parsed.content || finalSpeech;
                //             }
                //         } catch (e) {
                //             console.log("[Jarvis Brain] Ошибка парсинга JSON в финальном ответе");
                //         }
                //     }
                //     finalSpeech = finalSpeech.replace(/<\|.*?\|>/g, '').replace(/\{"content":\s*"(.*?)"\}/g, '$1').trim();
                //     if (finalSpeech && !isNotifyExecuted) {
                //         console.log(`[Jarvis] Озвучиваю отчет: ${finalSpeech}`);
                //         this.player.speak(finalSpeech);
                //         await dbRun("INSERT INTO messages (role, content) VALUES (?, ?)", ['assistant', finalSpeech]);
                //         return finalSpeech;
                //     }
                //     if (!finalSpeech.trim() && lastActionResult) {
                //         console.log("[Jarvis Brain] ИИ промолчал, использую результат команды для озвучки.");
                //         this.player.speak(lastActionResult);
                //         return lastActionResult;
                //     }
                //     return finalSpeech;
                // }
                // let simpleSpeech = assistantMessage.content || "";
                // simpleSpeech = simpleSpeech.replace(/<\|.*?\|>/g, '').replace(/\{"content":\s*"(.*?)"\}/g, '$1').trim();
                // if (simpleSpeech.toLowerCase() === "content" || !simpleSpeech) {
                //     simpleSpeech = "У меня всё отлично, сэр. Чем могу помочь?";
                // }
                // if (simpleSpeech && !isNotifyExecuted) {
                //     console.log(`[Jarvis] Голос (диалог): ${simpleSpeech}`);
                //     this.player.speak(simpleSpeech);
                //     await dbRun("INSERT INTO messages (role, content) VALUES (?, ?)", ['assistant', simpleSpeech]);
                // }
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
