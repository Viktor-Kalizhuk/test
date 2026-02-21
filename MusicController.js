class MusicController {
    constructor(db, musicState, api, player) {
        this.db = db;
        this.musicState = musicState;
        this.api = api;       // Теперь это yandexApi из твоего примера
        this.player = player; // Теперь это player из твоего примера
    }
    async init() {
        console.log("[MusicController] Запуск музыкальной системы...");
        
        // 1. Загружаем состояние из БД (вызываем свой же метод)
        const savedState = await this.getPersistentState();
        
        // Синхронизируем стейт в памяти с тем, что пришло из БД
        this.musicState.lastBatchTrackId = savedState.last_track_id || "";
        this.musicState.batchId = savedState.current_batch_id || "";

        // 2. Логика первого запуска или восстановления
        if (!this.musicState.batchId) {
            console.log("[MusicController] Первый запуск (batchId пуст). Настраиваем Волну...");
            await this.setupWaveSettings(); // Настраиваем и получаем первый batchId
        } else {
            console.log(`[MusicController] Восстановлено. Batch: ${this.musicState.batchId}, Last Track: ${this.musicState.lastBatchTrackId}`);
        }

        // 3. Предварительная загрузка очереди (по желанию)
        // if (!this.musicState.queue || this.musicState.queue.length === 0) {
        //     console.log("[MusicController] Загрузка начальной очереди...");
        //     await this.api.getTracks(this.musicState.batchId, this.musicState.lastBatchTrackId);
        // }

        console.log("[MusicController] Система готова к работе.");
    }
    async setLikeUniversal(trackId) {
        if (!this.userId) {
            console.error("[API] Ошибка: userId не найден.");
            return;
        }

        // ВНИМАНИЕ: Используй именно обратные кавычки (клавиша Ё)
        const url = `https://api.music.yandex.net{this.userId}/likes/tracks/add-multiple`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `OAuth ${this.token}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Yandex-Music-Client': 'Windows/6.0.45' // Помогает с валидацией
                },
                body: `track-ids=${trackId}`
            });

            const res = await response.json();
            console.log("[API] Результат лайка:", res);
            return res;
        } catch (e) {
            console.error("[API] Ошибка fetch:", e.message);
            return { error: e.message };
        }
    }

    async searchAndPlay(args) {
        try {
            const query = args.query;
            console.log(`[Поиск] Запрос: ${query}`);

            const r = Math.floor(Math.random() * 100000);
            const data = await this.api.request(`/search?text=${encodeURIComponent(query)}&type=track&page=0&r=${r}`);

            // ПРОВЕРКА: получили ли мы результаты
            const tracks = data.result?.tracks?.results;
            
            if (!tracks || tracks.length === 0) {
                console.log(`[Поиск] Ничего не найдено для: ${query}`);
                // await startPlayer(false, `Ничего не найдено для: ${query}`);
                return { error: "Ничего не найдено", status: "not_found" };
            }

            const track = tracks[0]; // Берем первый найденный трек
            const artistName = track.artists ? track.artists.map(a => a.name).join(', ') : 'Неизвестен';
            
            console.log(`[Поиск] Найдено: ${track.title} - ${artistName}`);

            // Озвучка перед запуском
            const introText = `Включаю ${track.title}, исполнитель ${artistName}`;
            const trackIds = track.id;
            const playedIds = await new Promise((resolve) => {
                this.db.all(`SELECT track_id FROM music_history WHERE track_id IN (${trackIds})`, (err, rows) => {
                    resolve(rows ? rows.map(r => r.track_id) : []);
                });
            });
            this.db.run(`INSERT INTO music_history (track_id, title, artist, played_Batch, played_at) 
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(track_id) DO UPDATE SET played_at=CURRENT_TIMESTAMP`, 
                    [track.id, track.title, artistName]);
            console.log(playedIds);

            // Запускаем плеер (startPlayer сам разберется с озвучкой и музыкой)
            // ВАЖНО: используем await, чтобы функция не завершилась раньше времени
            const streamUrl = await this.api.getTrackStreamUrl(track.id);
            this.player.play(track,streamUrl, introText);

            return { 
                status: "success", 
                message: `Трек ${track.title} найден и запущен`,
                trackTitle: track.title,
                artist: artistName
            };

        } catch (e) {
            console.error("[Поиск] Ошибка функции:", e.message);
            return { error: e.message, status: "error" };
        }
    }
    async setupWaveSettings(customSettings = {}) {
        console.log("[MusicController] Обновление настроек Волны...");
        try {
            const res = await this.api.updateWaveSettings(customSettings);
            
            // Сбрасываем ID последнего трека, чтобы Яндекс начал "с чистого листа" 
            // согласно новым настройкам
            this.musicState.lastBatchTrackId = "";
            
            console.log("[MusicController] Настройки применены:", res);
            return res;
        } catch (e) {
            console.error("[MusicController] Ошибка настройки Волны:", e.message);
            throw e;
        }
    }
    async setPersistentState(key, value) {
        console.log(key)
        console.log(value)
        return new Promise((resolve) => {
            this.db.run(
                `UPDATE music_state SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?`,
                [String(value), key],
                resolve()
            );
        });
    }

    async getPersistentState() {
        return new Promise((resolve) => {
            this.db.all(`SELECT key, value FROM music_state`, (err, rows) => {
                if (err) {
                    console.error("[MusicController] Ошибка загрузки стейта:", err);
                    return resolve({});
                }
                const state = {};
                if (rows) {
                    rows.forEach(row => {
                        state[row.key] = row.value;
                        // Сразу обновляем текущий объект состояния в памяти
                        if (row.key === 'current_batch_id') this.musicState.batchId = row.value;
                        if (row.key === 'last_track_id') this.musicState.lastBatchTrackId = row.value;
                    });
                }
                console.log("[MusicController] Состояние загружено из БД");
                resolve(state);
            });
        });
    }

    async playNext(res = null, isSkip = false) {
        try {
            this.musicState.sessionId = this.musicState.sessionId || '';
            // 1. Фидбек по прошлому треку
            if (this.musicState.currentTrack) {
                const played = this.musicState.progress?.current || 0;
                const lastTrackId = this.musicState.currentTrack.id;

                // Очищаем стейт немедленно
                this.musicState.currentTrack = null;
                this.musicState.progress = null;

                await this.api.sendFeedback(
                    this.musicState.batchId, 
                    lastTrackId, 
                    this.musicState.isPlaying ? "skip" : "trackFinished", 
                    played
                );
            }

            // 2. Проверка и обновление очереди
            if (!this.musicState.queue || this.musicState.queue.length === 0) {
                console.log("[MusicController] Очередь пуста. Запрашиваю свежие треки...");
                const result = await this.api.getTracks(
                    this.musicState.batchId, 
                    this.musicState.lastBatchTrackId,
                    this.lastIncomingIds
                );

                if (result && result.sequence) {
                    // console.log(result)
                    this.musicState.batchId = result.batchId;
                    // this.musicState.sessionId = result.radioSessionId; 
                    if (result.radioSessionId) {
                        this.musicState.sessionId = result.radioSessionId;
                        console.log("[Music] Получен НОВЫЙ ID сессии:", result.radioSessionId);
                    } else {
                        console.log("[Music] Используем ТЕКУЩИЙ ID сессии:", this.musicState.sessionId);
                    }
                    this.musicState.sessionId = result.radioSessionId || result.sessionId;
                    console.log(this.musicState.sessionId) 
                    // console.log(this.musicState.sessionId)
                    await this.setPersistentState('current_batch_id', result.batchId);

                    // const incomingIds = result.sequence.map(item => String(item.track.id));
                    const incomingIds = result.sequence.map(item => String(item.track.id));

                    // Проверка на "День сурка"
                    if (this.lastIncomingIds && this.lastIncomingIds[0] === incomingIds[0]) {
                        // console.log("[MusicController] Обнаружен цикл! Сбрасываю batchId...");
                        // this.musicState.batchId = null; 
                        // this.musicState.lastBatchTrackId = null;
                        // Ждем чуть дольше и пробуем чистый запрос
                        // await new Promise(r => setTimeout(r, 500));
                        // return await this.playNext(res, false);
                        // if (this.musicState.isCycleDetected) {
                            console.log("[Music] Цикл! Делаю жесткий сброс волны...");
                            await this.api.resetWave();
                            this.musicState.batchId = null; // Очищаем batch, чтобы начать с нуля
                            this.musicState.lastBatchTrackId = null;
                            this.musicState.lastBatchTrackAlbum = null;
                            // this.musicState.isCycleDetected = false;
                        // }
                    }
                    this.lastIncomingIds = incomingIds; 
                    const placeholders = incomingIds.map(() => '?').join(',');

                    // Ищем прослушанные за неделю
                    const playedIds = await new Promise((resolve) => {
                        this.db.all(
                            `SELECT DISTINCT track_id FROM music_history 
                             WHERE track_id IN (${placeholders}) 
                             AND played_at > datetime('now', '-1 days')`,
                            incomingIds,
                            (err, rows) => {
                                resolve()
                            }
                        );
                    });
                    console.log(incomingIds)
                    // const freshTracks = result.sequence;
                    const freshTracks = result.sequence;

                    if (freshTracks.length === 0) {
                        console.log("[MusicController] Весь батч в истории. Рекурсия...");
                        this.musicState.queue = [];
                        await new Promise(r => setTimeout(r, 1000)); // Даем Яндексу "подумать"
                        return await this.playNext(res, false);
                    }

                    this.musicState.queue = freshTracks;
                }
            }

            // 3. Запуск нового трека
            const trackData = this.musicState.queue.shift();
            const track = trackData.track;
            const artistNames = track.artists.map(a => a.name).join(', ');
            // console.log(trackData)
            // const albumId = (t.albums && t.albums.length > 0) ? t.albums[0].id : '';
            // Запись в БД
            this.db.run(
                `INSERT INTO music_history (track_id, title, artist, played_Batch, played_at) 
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(track_id) DO UPDATE SET played_at=CURRENT_TIMESTAMP`,
                [String(track.id), track.title, artistNames, this.musicState.batchId]
            );

            // Фидбек о старте
            this.musicState.lastBatchTrackId = track.id;
            this.musicState.lastBatchTrackAlbum = track.albums[0].id;
            await this.api.sendFeedback(this.musicState.batchId, track.id, "trackStarted");


            // Играем
            // await this.player.play(track, `Включаю ${track.title}, исполнитель ${artistNames}`);
            // const streamUrl = await getTrackStreamUrl(track.id);
            // const streamUrl = await this.api.getTrackStreamUrl(track.id); 
            // await this.player.play(
            //     track, 
            //     `Включаю ${track.title}`, 
            //     () => this.playNext() // Тот самый callback завершения
            // );

            const streamUrl = await this.api.getTrackStreamUrl(track.id);
            const intro = `Включаю ${track.title}, исполнитель ${artistNames}`;

            // ВАЖНО: передаем ТРИ аргумента в правильном порядке
             // console.log(streamUrl)
            await this.player.play(track, streamUrl, intro, () => this.playNext());
            // await this.player.play(track, streamUrl, `Включаю ${track.title}`, () => this.playNext());
            await this.setPersistentState('last_track_id', track.id);

            if (res && typeof res.json === 'function') return res.json({ output: track });
            return { status: "success", trackId: track.id };

        } catch (e) {
            console.error("[MusicController] Critical Error:", e);
            if (res && typeof res.json === 'function') return res.status(500).json({ error: e.message });
        }
    }
    async playFromHistory(trackId, res = null) {
        // 1. Ищем трек в БД (или сразу запрашиваем API Яндекса по ID)
        // В API Яндекс.Музыки это обычно GET /tracks/{trackId}
        // const trackData = await httpRequest({ 
        //     hostname: API_BASE_URL, 
        //     path: `/tracks/${trackId}` 
        // });
        const trackData = await this.api.request(`/tracks/${trackId}`);
        const trackUrl = await this.api.getTrackStreamUrl(trackId);
        if (trackData.result && trackData.result[0]) {
            const track = trackData.result[0];
            await this.player.play(track, trackUrl, `Возвращаемся к ${track.title}`);

            this.db.run(`UPDATE music_history SET played_at = CURRENT_TIMESTAMP WHERE track_id = ?`, [trackId]);
            
            return res?.json ? res.json({ status: "success", track }) : { status: "success" };
        }
    }
}

module.exports = MusicController;
