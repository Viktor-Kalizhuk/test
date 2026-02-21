const https = require('https');
const crypto = require('crypto');

class ApiYandexClient {
    constructor(httpClient, baseUrl, token, db) {
        this.http = httpClient; // Экземпляр класса HttpClient
        this.baseUrl = baseUrl;
        this.token = token;
        this.db = db;
    }
    async updateWaveSettings(settings = {}) {
        const defaultSettings = {
            moodEnergy: "all",
            diversity: "favorite",
            // diversity: "discover",
            type: "rotor",
            language: "any"
        };
        
        const path = '/rotor/station/user:onyourwave/settings3';
        const body = { ...defaultSettings, ...settings };
        
        // HttpClient сам рассчитает Content-Length, если мы передадим объект
        return await this.request(path, 'POST', body);
    }
    async request(path, method = 'GET', body = null, extraHeaders = {}) {
        const options = {
            hostname: this.baseUrl,
            path: path,
            method: method,
            headers: {
                'Authorization': `OAuth ${this.token}`,
                // 'X-Yandex-Music-Client': 'WindowsPhone/3.17',
                'X-Yandex-Music-Client': 'os=unknown; device=unknown',
                'User-Agent': 'Yandex-Music-API',
                // 'X-Yandex-Music-Device': 'os=unknown; device=unknown',
                // 'User-Agent': 'Yandex-Music-API', // Или имитация мобильного приложения
                // 'Authorization': `OAuth ${this.token}`,
                ...extraHeaders // Сюда прилетит наш Content-Type
            }
        };
        return await this.http.request(options, body);
    }

    // async getTracks(batchId, lastTrackId = null) {
    //     let path = `/rotor/station/user:onyourwave/tracks?batch-id=${batchId || ''}`;
    //     if (lastTrackId) path += `&queue=${lastTrackId}`;
    //     const res = await this.request(path, 'GET');
    //     console.log(path)
    //     console.log(res)
    //     return res?.result || null;
    // }
    async getAccountStatus() {
        const res = await this.request('/account/status', 'GET');
        this.userId = res?.result?.account?.uid;
        console.log("[API] Мой UID:", this.userId);
        return this.userId;
    }
    async getTracks(batchId = null, playedIds = []) {
        const params = new URLSearchParams({
            'viz': 'v2',
            'from': 'mweb-pwa',
            'external-playlist': 'test' // Любая строка, чтобы сбить кеш
        });

        if (batchId) params.append('batch-id', batchId);
        
        const trackHistory = await new Promise((resolve) => {
            // Выбираем только track_id, чтобы не тянуть лишнее
            this.db.all(`SELECT track_id FROM music_history ORDER BY played_at DESC LIMIT 50`, (err, rows) => {
                resolve(rows || []);
            });
        });

        if (trackHistory.length > 0) {
            // 1. Извлекаем только ID: [123, 456, ...]
            const idsOnly = trackHistory.map(row => row.track_id);
            
            // 2. Превращаем в строку: "123,456,789"
            params.append('track-ids-played', idsOnly.join(','));
        }

        // Передавайте список уже проигранных ID через запятую
        // console.log(playedIds)
        // if (playedIds.length > 0) {
        //     params.append('track-ids-played', playedIds.join(','));
        // }
        console.log(params)
        // Рекомендую сменить на oneself для личных рекомендаций
        const path = `/rotor/station/user:oneself/tracks?${params.toString()}`;
        
        const res = await this.request(path, 'GET');
        console.log(res)
        return res?.result || null;
    }
    async setDislikeUniversal(trackId) {
        if (!this.userId) return { error: "no_userid" };

        // Эндпоинт удаления (дизлайка) для радио и плейлистов
        const path = `/users/${this.userId}/likes/tracks/remove`;
        const body = `track-ids=${trackId}`;

        return await this.request(path, 'POST', body, {
            'Content-Type': 'application/x-www-form-urlencoded'
        });
    }
    async setLikeUniversal(trackId) {
        if (!this.userId) {
            console.error("[API] Ошибка: userId не найден.");
            return { error: "no_userid" };
        }

        const path = `/users/${this.userId}/likes/tracks/add-multiple`;
        
        // Формируем СТРОКУ, твой HttpClient её не будет JSON.stringify
        const body = `track-ids=${trackId}`;

        // Передаем заголовок прямо в наш request
        return await this.request(path, 'POST', body, {
            'Content-Type': 'application/x-www-form-urlencoded'
        });
    }
    async sendFeedback(batchId, trackId, type, playedSeconds = 0) {
        const path = `/rotor/station/user:onyourwave/feedback?batch-id=${batchId}`;

        const body = {
            type: type,
            timestamp: new Date().toISOString(),
            clientNow: new Date().toISOString(),
            trackId: String(trackId),
            batchId: batchId,
            totalPlayedSeconds: playedSeconds,
            from: "onyourwave"
        };
        let res = await this.request(path, 'POST', body);
        // console.log(path);
        // console.log(type);
        // console.log(res);
        return res;
    }
    async getTrackStreamUrl(trackId) {
        // 1. Получаем список ссылок на XML
        const info = await this.request(`/tracks/${trackId}/download-info`, 'GET');
        
        // Яндекс возвращает массив в result. Обычно нам нужен второй или первый элемент.
        // Безопасно ищем downloadInfoUrl
        let downloadUrl = null;
        if (info && info.result && Array.isArray(info.result)) {
            // Ищем mp3 с нормальным битрейтом или берем первый попавшийся
            const mp3info = info.result.find(i => i.codec === 'mp3') || info.result[0];
            downloadUrl = mp3info ? mp3info.downloadInfoUrl : null;
        }

        if (!downloadUrl) {
            console.error("[ApiYandexClient] Full Info Response:", JSON.stringify(info));
            throw new Error("downloadInfoUrl не найден в ответе Яндекса");
        }

        // 2. Твоя проверенная логика получения XML
        const xmlData = await new Promise((r, reject) => {
            const req = https.get(downloadUrl, res => {
                let d = ''; 
                res.on('data', c => d += c); 
                res.on('end', () => r(d));
            });
            req.on('error', reject);
        });

        // 3. Твоя проверенная логика парсинга (через регулярки)
        try {
            const host = xmlData.match(/<host>(.*?)<\/host>/)[1];
            const pathFull = xmlData.match(/<path>(.*?)<\/path>/)[1];
            const ts = xmlData.match(/<ts>(.*?)<\/ts>/)[1];
            const s = xmlData.match(/<s>(.*?)<\/s>/)[1];
            
            // Убираем ведущий слэш, если он есть
            const cleanPath = pathFull.startsWith('/') ? pathFull.substring(1) : pathFull;
            
            // Соль Яндекса (не меняется годами)
            const secret = "XGRlBW9FXlekgbPrRHuSiA";
            const sign = crypto.createHash('md5')
                               .update(secret + cleanPath + s)
                               .digest('hex');
                
            const finalUrl = `https://${host}/get-mp3/${sign}/${ts}/${cleanPath}`;
            return finalUrl;
        } catch (e) {
            throw new Error("Ошибка парсинга XML: " + e.message);
        }
    }
    


}

module.exports = ApiYandexClient;
