// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// + 日常写真コンテキスト記憶機能 + プリクラ機能追加

// ============================================
// APIキーローテーション機能
// ============================================

function getRotatedAPIKey(context) {
    // 日本時間（JST）で現在時刻を取得
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const jstTime = new Date(utc + (3600000 * 9));
    const hour = jstTime.getHours();

    // 6時間ごとにキーを切り替え
    let keyName;
    if (hour >= 0 && hour < 6) keyName = 'GEMINI_API_KEY';
    else if (hour >= 6 && hour < 12) keyName = 'GEMINI_API_KEY2';
    else if (hour >= 12 && hour < 18) keyName = 'GEMINI_API_KEY3';
    else keyName = 'GEMINI_API_KEY4';

    const apiKey = context.env[keyName];
    console.log(`Current JST Hour: ${hour}, Using Key: ${keyName}, Key exists: ${!!apiKey}`);

    // フォールバック処理
    if (!apiKey) {
        console.warn(`${keyName} not found, trying fallback keys...`);
        const fallbackKeys = ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GEMINI_API_KEY3', 'GEMINI_API_KEY4'];
        for (const key of fallbackKeys) {
            if (context.env[key]) {
                console.log(`Using fallback key: ${key}`);
                return context.env[key];
            }
        }
        throw new Error('No valid GEMINI_API_KEY found in environment variables');
    }
    return apiKey;
}

function getImageAPIKey(context) {
    const apiKey = context.env['GEMINI_API_KEY_IMAGE1'];
    if (!apiKey) {
        console.error('GEMINI_API_KEY_IMAGE1 not found in environment variables');
        throw new Error('Image generation API key not configured');
    }
    return apiKey;
}

// ============================================
// シンプル化された機嫌エンジン
// ============================================

const TOKYO_TZ = 'Asia/Tokyo';

function tanh(x) {
    return Math.tanh(x);
}

class UserProfile {
    constructor(profile = {}) {
        this.gender = profile.gender || "FEMALE";
        this.age_group = profile.age_group || "TEEN";
        this.style = profile.style || "GAL";
        this.relationship = profile.relationship || "LOW";
        this.affinity_points = profile.affinity_points || 0.0;
    }
}

// ↓↓↓ --- SimpleMoodEngine クラス定義 --- ↓↓↓
class SimpleMoodEngine {
    constructor(userProfile = {}, initialMoodScore = 0.0, initialContinuity = 0) {
        this.AFFINITY_THRESHOLDS = {"MEDIUM": 15.0, "HIGH": 35.0};
        this.last_mentioned_place = null; // 場所検索用
        this.daily_activities = {}; // 重複回答防止用
        this.last_photo_context = null; // { activity: string, place: object | null, isPurikura: boolean }

        this.gal_friendly_keywords = [ 'まじ', '最高', 'ヤバい', 'やばい', '可愛い', 'かわいい', 'エモい', '神', '好き', 'すごい', 'わかる', 'それな', 'ファッション', '服', 'コスメ', 'メイク', 'カフェ', 'スイーツ', '映え', '写真', 'インスタ', 'TikTok', '推し', 'アイドル', 'ライブ', 'フェス', '旅行', '海', 'プール', '画像', '写真', '絵' ];
        this.generic_ai_queries = [ 'おすすめ', 'どこ', 'どう', '何', '教えて', '調べて', 'って何', '方法', 'やり方', '違い', '意味', '理由', '原因' ];

        this.user_profile = new UserProfile(userProfile);
        this.mood_score = initialMoodScore;
        this.continuity = initialContinuity;
        this.last_message_time = Date.now();
    }

    _get_now() {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        return new Date(utc + (3600000 * 9));
    }

    _get_time_context() {
        const now = this._get_now();
        const year = now.getFullYear(); const month = now.getMonth() + 1; const day = now.getDate(); const hour = now.getHours(); const minute = now.getMinutes(); const weekday = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'][now.getDay()];
        return { year, month, day, hour, minute, weekday, dateString: `${year}年${month}月${day}日(${weekday})`, timeString: `${hour}時${minute}分` };
    }

    _is_generic_query(query) { const normalized = query.toLowerCase(); return this.generic_ai_queries.some(keyword => normalized.includes(keyword)); }
    _needs_realtime_search(query) { const normalized = query.toLowerCase(); const realtime_keywords = ['今日', '今', '現在', '最新', '天気', '気温', 'ニュース', '今週', '今月', 'いま', '最近']; return realtime_keywords.some(keyword => normalized.includes(keyword)); }
    _is_gal_friendly_topic(query) { const normalized = query.toLowerCase(); return this.gal_friendly_keywords.some(keyword => normalized.includes(keyword)); }
    _is_asking_about_daily_life(query) { const normalized = query.toLowerCase(); const dailyLifeKeywords = ['今日', '何してた', '何した', 'どうだった', '最近', 'どう過ごし', 'どこ行った', 'どこ行って', '昨日', '週末', '休み', 'どんな感じ', 'どんなこと', '何か面白いこと', '楽しかった', '何してる', '何してるの', 'どうしてる', 'どうしてるの', '元気', 'どう', '調子', '過ごして', '一昨日', '先週', 'この前', 'さっき', '今朝', '午前', '午後', 'バイト', '今何', 'いま何', 'なにしてる', 'なにしてるの', '今なに']; return dailyLifeKeywords.some(keyword => normalized.includes(keyword)); }
    _extract_time_reference(query) { const normalized = query.toLowerCase(); if (normalized.includes('今何') || normalized.includes('今なに') || normalized.includes('いま何') || normalized.includes('何してる')) return 'right_now'; if (normalized.includes('今日') || normalized.includes('きょう')) return 'today'; if (normalized.includes('昨日') || normalized.includes('きのう')) return 'yesterday'; if (normalized.includes('一昨日') || normalized.includes('おととい')) return 'day_before_yesterday'; if (normalized.includes('週末') || normalized.includes('土曜') || normalized.includes('日曜')) return 'weekend'; if (normalized.includes('先週') || normalized.includes('この前')) return 'last_week'; return 'today'; }
    _is_asking_about_place(query) { const normalized = query.toLowerCase(); const placeKeywords = ['場所', 'どこ', 'アクセス', '行き方', '住所', 'url', 'リンク', '教えて', '詳しく', '情報', 'どこにある', 'どうやって行く', 'どこにあるの', 'どこだっけ']; return placeKeywords.some(keyword => normalized.includes(keyword)); }
    _is_asking_about_limited_time(query) { const normalized = query.toLowerCase(); const limitedTimeKeywords = ['期間限定', '限定', '今なん', '今何', '最新', '新作', '新しい', 'いまなん', 'いま何', '今の', 'セール', 'キャンペーン', 'フェア', '今月', 'おすすめ', 'やってる', 'ある？', 'あるの', '今度', '次', '秋限定', '冬限定', '春限定', '夏限定']; return limitedTimeKeywords.some(keyword => normalized.includes(keyword)); }
    _extract_brand_name(query) { const normalized = query.toLowerCase(); const brands = ['マクド', 'マック', 'マクドナルド', 'mcdonald', 'スタバ', 'スターバックス', 'starbucks', 'ユニクロ', 'uniqlo', 'gu', 'ジーユー', 'セブン', 'ローソン', 'ファミマ', '無印', '無印良品', 'muji', 'コンビニ', 'カフェ']; for (const brand of brands) { if (normalized.includes(brand)) { return brand; } } return null; }

    _update_continuity(message) {
        const now = Date.now(); const timeDiff = (now - this.last_message_time) / 1000;
        if (timeDiff < 300) this.continuity = Math.min(10, this.continuity + 1);
        else if (timeDiff > 3600) this.continuity = Math.max(0, this.continuity - 3);
        else this.continuity = Math.max(0, this.continuity - 1);
        this.last_message_time = now;
    }

    // ↓↓↓ --- ここがエラー箇所 --- ↓↓↓
    calculate_mood_change(message, hasImage = false, isDrawing = false) {
        this._update_continuity(message);
        let mood_change = 0;
        if (this.continuity >= 5) mood_change += 0.2;
        if (hasImage) mood_change += 0.4;
        if (isDrawing) mood_change += 0.5;
        if (this._is_gal_friendly_topic(message)) mood_change += 0.3;
        else if (!hasImage && !isDrawing) mood_change -= 0.1;
        if (this.user_profile.relationship === "HIGH") mood_change *= 1.5;
        else if (this.user_profile.relationship === "LOW") mood_change *= 0.5;
        const timeContext = this._get_time_context(); const hour = timeContext.hour; const weekday = timeContext.weekday;
        if (weekday !== '土曜日' && weekday !== '日曜日' && hour >= 7 && hour <= 8) mood_change -= 0.3;
        else if (weekday === '金曜日' && hour >= 18) mood_change += 0.2;
        this.mood_score = Math.max(-1.0, Math.min(1.0, this.mood_score + mood_change));
        this._update_relationship(mood_change);
        return mood_change; // ★return文を追加
    }
    // ↑↑↑ --- ここがエラー箇所 --- ↑↑↑

    _update_relationship(mood_change) {
        if (mood_change > 0.1) this.user_profile.affinity_points += mood_change * 5.0;
        const current_rel = this.user_profile.relationship;
        if (current_rel === "LOW" && this.user_profile.affinity_points >= this.AFFINITY_THRESHOLDS["MEDIUM"]) { this.user_profile.relationship = "MEDIUM"; return "LEVEL_UP_MEDIUM"; }
        else if (current_rel === "MEDIUM" && this.user_profile.affinity_points >= this.AFFINITY_THRESHOLDS["HIGH"]) { this.user_profile.relationship = "HIGH"; return "LEVEL_UP_HIGH"; }
        return null;
    }

    get_mood_response_style() {
        if (this.mood_score > 0.5) return "high";
        else if (this.mood_score < -0.3) return "low";
        else return "medium";
    }

    _is_asking_about_photo(query) {
        const normalized = query.toLowerCase();
        const photoKeywords = ['これ', '写真', '画像', 'どこ', 'なに', '何', '場所', 'どんな', '誰'];
        return photoKeywords.some(keyword => normalized.includes(keyword));
    }
}
// ↑↑↑ --- SimpleMoodEngine クラス定義ここまで --- ↑↑↑

// ============================================
// Cloudflare Worker エントリーポイント
// ============================================

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const body = await context.request.json();
        const userMessage = body.message || '';
        const conversationHistory = body.conversationHistory || [];
        const userProfile = body.userProfile || {};
        const moodScore = body.moodScore || 0;
        const continuity = body.continuity || 0;
        const imageData = body.image || null;
        const isDrawing = body.isDrawing || false;

        // ★★★ moodEngine の初期化 ★★★
        const moodEngine = new SimpleMoodEngine(userProfile, moodScore, continuity);
        // ★★★★★★★★★★★★★★★★★★★

        // ★デバッグ用: moodEngineが正しく生成されたか確認
        if (!moodEngine || typeof moodEngine.calculate_mood_change !== 'function') {
             console.error('CRITICAL: moodEngine is not initialized correctly or calculate_mood_change is missing!');
             console.error('moodEngine type:', typeof moodEngine);
             console.error('moodEngine value:', moodEngine);
             return new Response(JSON.stringify({ error: 'Internal server error', message: 'Mood engine initialization failed.' }), { status: 500, headers: corsHeaders });
        }

        const hasImage = imageData !== null;
        moodEngine.calculate_mood_change(userMessage, hasImage, isDrawing); // ★エラー箇所
        const moodStyle = moodEngine.get_mood_response_style();
        const timeContext = moodEngine._get_time_context();

        let response;
        let generatedImageBase64 = null;

        // ★★★ 写真コンテキスト処理 ★★★
        if (moodEngine.last_photo_context && moodEngine._is_asking_about_photo(userMessage)) {
            console.log('User is asking about the last photo context:', moodEngine.last_photo_context);
            const contextInfo = moodEngine.last_photo_context;
            let contextDescription = contextInfo.isPurikura ? "友達と撮ったプリクラ" : `「${contextInfo.activity}」の時の写真`;
            if (contextInfo.place && !contextInfo.isPurikura) { contextDescription += ` 場所は「${contextInfo.place.name}」`; }
            const photoContextPrompt = `【状況】\nあなたは直前にユーザーに日常の写真を送りました。\nその写真は「${contextDescription}」という状況のものです。\n\nユーザーがその写真について「${userMessage}」と質問しています。\n\n【指示】\n1. あなたが覚えている写真の状況 (${contextDescription}) を踏まえ、ユーザーの質問に自然に答えてください。\n2. ギャルっぽい口調で、友達に話すように。\n3. 場所の情報 (${contextInfo.place ? contextInfo.place.name + ', URL: ' + contextInfo.place.url : 'なし'}) も必要なら自然に含めてください。(プリクラの場合は場所情報は不要)\n4. 2-3文程度で簡潔に。\n\n例 (ユーザー「これどこ？」・プリクラでない場合):\n「あ、これね！${contextInfo.place ? contextInfo.place.name + 'だよ〜！まじ映えスポット✨' : 'えっと、これは確か〜'}」\n例 (ユーザー「誰と撮ったの？」・プリクラの場合):\n「これは仲良いことプリ撮ったときのやつ〜！まじ盛れたっしょ✌️」\n\nでは、返答してください：`;
            response = await callGeminiAPI( getRotatedAPIKey(context), photoContextPrompt, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
            moodEngine.last_photo_context = null; console.log('Cleared last_photo_context');
        } else {
            // ★★★ 通常の処理フロー ★★★
            if (moodEngine.last_photo_context) { moodEngine.last_photo_context = null; console.log('User did not ask, clearing last_photo_context'); }
            const isGenericQuery = moodEngine._is_generic_query(userMessage);
            const needsRealtimeSearch = moodEngine._needs_realtime_search(userMessage);
            const isAskingDailyLife = moodEngine._is_asking_about_daily_life(userMessage);
            const isAskingAboutPlace = moodEngine._is_asking_about_place(userMessage);
            const isAskingLimitedTime = moodEngine._is_asking_about_limited_time(userMessage);

            if (isAskingLimitedTime) { /* ... (省略 - 変更なし) ... */ }
            else if (isAskingAboutPlace && moodEngine.last_mentioned_place) { /* ... (省略 - 変更なし) ... */ }
            else {
                let shouldGenerateDailyPhoto = false; let isPurikura = false;
                if (isAskingDailyLife && !isDrawing && !hasImage) {
                    const timeReference = moodEngine._extract_time_reference(userMessage); const today = new Date().toISOString().split('T')[0]; const activityKey = `${today}_${timeReference}`;
                    if (!moodEngine.daily_activities[activityKey]) { const probability = moodStyle === 'high' ? 0.8 : moodStyle === 'medium' ? 0.5 : 0.2; shouldGenerateDailyPhoto = Math.random() < probability; }
                    console.log(`Daily life Q. Time ref: ${timeReference}, Answered: ${!!moodEngine.daily_activities[activityKey]}, Gen photo: ${shouldGenerateDailyPhoto}`);
                    if (shouldGenerateDailyPhoto && Math.random() < 0.15) { isPurikura = true; console.log('*** Purikura Time! ***'); } // プリクラチャンス
                }

                if (isDrawing && userMessage.trim()) { /* ... (省略 - お絵描き処理 変更なし) ... */ }
                else {
                    if (shouldGenerateDailyPhoto) {
                        try {
                            console.log(`Generating daily photo... ${isPurikura ? '(Purikura Mode)' : ''}`);
                            const imageApiKey = getImageAPIKey(context); const gyarumiFaceImage = await loadGyarumiFaceImage(); const timeReference = moodEngine._extract_time_reference(userMessage);
                            let activityResponse = ''; let realPlace = null; let photoContextActivity = '';

                            if (isPurikura) { activityResponse = "友達とプリクラ撮ってきた！"; photoContextActivity = activityResponse; }
                            else {
                                const isRightNow = timeReference === 'right_now';
                                let activityPrompt = isRightNow ? `ユーザー「${userMessage}」今何してる？ 現在時刻: ${timeContext.timeString} 進行形で1文で答えて(例:カフェでまったりしてる)` : `ユーザー「${userMessage}」今日/最近何してた？ 1文で答えて(例:原宿のカフェ行ってきた)`;
                                activityResponse = await callGeminiAPI( getRotatedAPIKey(context), activityPrompt, [], moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                                console.log('Activity decided:', activityResponse); photoContextActivity = activityResponse;
                                if (activityResponse && (activityResponse.includes('カフェ') || activityResponse.includes('レストラン') || activityResponse.includes('ショッピング'))) { realPlace = await searchRealPlace(activityResponse, context); console.log('Real place:', realPlace); }
                            }

                            const today = new Date().toISOString().split('T')[0]; const activityKey = `${today}_${timeReference || 'unknown'}`; moodEngine.daily_activities[activityKey] = { activity: activityResponse, timestamp: Date.now(), place: realPlace };
                            if (realPlace) { moodEngine.last_mentioned_place = realPlace; }
                            moodEngine.last_photo_context = { activity: photoContextActivity, place: realPlace, isPurikura: isPurikura }; console.log('Saved photo context:', moodEngine.last_photo_context);

                            const photoPrompt = createDailyPhotoPrompt(activityResponse, timeContext, moodStyle, isPurikura);
                            generatedImageBase64 = await generateImage(photoPrompt, imageApiKey, gyarumiFaceImage); console.log('Daily photo generated:', !!generatedImageBase64);

                            const quickResponses = isPurikura ? ["プリ撮った！まじ盛れたっしょ✨", "友達とプリ〜！見てみて💕", "じゃん！プリクラ！✌️"] : ["じゃーん、みてみて！✨", "写真撮ったよ〜！", "これどう？いい感じっしょ？💕", "はい、おまたせ〜！", "こんな感じだったよ！", "撮ってみた！"];
                            if (generatedImageBase64) { response = quickResponses[Math.floor(Math.random() * quickResponses.length)]; }
                            else { console.warn('Photo gen failed, returning activity text'); response = activityResponse; moodEngine.last_photo_context = null; }

                        } catch (dailyPhotoError) {
                            console.error('Error during daily photo generation:', dailyPhotoError);
                            response = await callGeminiAPI( getRotatedAPIKey(context), userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData );
                            generatedImageBase64 = null; moodEngine.last_photo_context = null;
                        }
                    } else {
                        response = await callGeminiAPI( getRotatedAPIKey(context), userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData );
                    }
                }
            }
        } // ★★★ 写真コンテキスト処理の終了 ★★★

        return new Response(JSON.stringify({ response, moodScore: moodEngine.mood_score, continuity: moodEngine.continuity, relationship: moodEngine.user_profile.relationship, generatedImage: generatedImageBase64 ? `data:image/png;base64,${generatedImageBase64}` : null }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    } catch (error) {
        console.error('Error in onRequest:', error); // ★詳細なエラーログ
        return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
}

// ============================================
// 画像生成関数など (変更なし or 前回の修正のまま)
// ============================================
// (searchRealPlace, searchLimitedTimeInfo, loadGyarumiFaceImage,
//  createDailyPhotoPrompt (前回修正済み), createPurikuraPrompt (前回追加済み),
//  createImageGenerationPrompt (前回修正済み), generateImage, callGeminiAPI,
//  createSimpleGyarumiPrompt は変更なし or 前回の修正のまま)
// ... (省略) ...

// === ここから下は前回の修正が反映されていることを確認 ===

// リアルな店舗を検索
async function searchRealPlace(activity, context) {
    try {
        let searchQuery = '';
        if (activity.includes('cafe') || activity.includes('カフェ')) searchQuery = '東京 おしゃれカフェ インスタ映え 話題 2025';
        else if (activity.includes('restaurant') || activity.includes('レストラン') || activity.includes('ランチ') || activity.includes('ご飯')) searchQuery = '東京 おしゃれレストラン インスタ映え 話題 2025';
        else if (activity.includes('shopping') || activity.includes('買い物')) searchQuery = '東京 おしゃれショップ 話題 2025';
        else searchQuery = '東京 おしゃれスポット インスタ映え 話題 2025';
        const searchResults = await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(searchQuery)}`);
        if (!searchResults.ok) { console.error('Web search failed'); return null; }
        const data = await searchResults.json();
        if (data && data.results && data.results.length > 0) {
            const topResults = data.results.slice(0, 3);
            const selectedResult = topResults[Math.floor(Math.random() * topResults.length)];
            return { name: selectedResult.title, url: selectedResult.url, description: selectedResult.description || selectedResult.snippet || '' };
        } return null;
    } catch (error) { console.error('Error searching for real place:', error); return null; }
}
// 期間限定・最新情報を検索
async function searchLimitedTimeInfo(brandName, userQuery, context) {
    try {
        const now = new Date(); const year = now.getFullYear(); const month = now.getMonth() + 1; let season = '';
        if (month >= 3 && month <= 5) season = '春'; else if (month >= 6 && month <= 8) season = '夏'; else if (month >= 9 && month <= 11) season = '秋'; else season = '冬';
        let searchQuery = brandName ? `${brandName} 期間限定 新作 ${year}年${month}月 ${season}` : `期間限定 ${season} 新作 話題 ${year}`;
        const searchResults = await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(searchQuery)}`);
        if (!searchResults.ok) { console.error('Web search failed'); return null; }
        const data = await searchResults.json();
        if (data && data.results && data.results.length > 0) {
            const topResults = data.results.slice(0, 3);
            const summaries = topResults.map(result => ({ title: result.title, url: result.url, snippet: result.description || result.snippet || '' }));
            return { query: searchQuery, results: summaries, brand: brandName };
        } return null;
    } catch (error) { console.error('Error searching for limited time info:', error); return null; }
}
// ぎゃるみの顔写真を読み込む
async function loadGyarumiFaceImage() {
    try {
        const response = await fetch('/gyarumi_face.jpg'); if (!response.ok) return null;
        const blob = await response.blob();
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onloadend = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
    } catch (error) { console.error('Error loading gyarumi face image:', error); return null; }
}
// 日常写真のプロンプトを生成 (家モード＆ファッション修正＆プリクラ引数追加版)
function createDailyPhotoPrompt(gyarumiResponse, timeContext, moodStyle, isPurikura = false) {
    const detailedCharacterDescription = `
DETAILED CHARACTER DESCRIPTION (based on reference image):
Basic Information: Japanese female, age 17-19, Real person appearance (not anime/illustration), Youth-emotional, naughty cat-like face.
Face & Features: Large brown eyes, defined eyeliner, pink eyeshadow tones, bright smile showing teeth, fair complexion, small delicate features, East Asian cat-like structure.
Hair: Long below chest, Pastel color gradient (Pink/mint green streaks), Straight blunt bangs (hime-cut).
Fashion Style (Harajuku/Jirai-kei/Yume-kawaii with K-POP influence): Pastel palette, Layered outfits, accessories, Trendy Japanese street fashion + K-POP idol aesthetics, Varying outfit details (CRITICAL: avoid exact same outfit).
Overall Aesthetic: Kawaii, colorful, Instagram-worthy, energetic, Modern Japanese gyaru/gal + K-POP trends.`;

    if (isPurikura) { return createPurikuraPrompt(detailedCharacterDescription, timeContext); } // ★プリクラ処理へ分岐

    let activity = ''; let location = ''; let photoType = 'selfie'; let includesFriend = Math.random() < 0.3; let isHomeRelaxMode = false;
    if (/カフェ|コーヒー|飲み物|スタバ|cafe/i.test(gyarumiResponse)) { activity = 'at a trendy cafe'; location = 'a stylish modern cafe'; photoType = Math.random() < 0.5 ? 'selfie' : 'drink_photo'; }
    else if (/公園|散歩|outside|外/i.test(gyarumiResponse)) { activity = 'at a park'; location = 'a beautiful park'; photoType = 'selfie'; }
    else if (/ショッピング|買い物|服|shop/i.test(gyarumiResponse)) { activity = 'shopping'; location = 'a trendy shopping area'; photoType = Math.random() < 0.6 ? 'selfie' : 'outfit_photo'; }
    else if (/ランチ|ご飯|食事|レストラン/i.test(gyarumiResponse)) { activity = 'having a meal'; location = 'a cute restaurant'; photoType = Math.random() < 0.4 ? 'selfie' : 'food_photo'; }
    else if (/海|ビーチ|beach/i.test(gyarumiResponse)) { activity = 'at the beach'; location = 'a beautiful beach'; photoType = 'selfie'; }
    else if (/家|部屋|room|ごろごろ|ゴロゴロ/i.test(gyarumiResponse)) { activity = 'relaxing at home'; location = 'a cute bedroom/living room'; photoType = 'selfie'; isHomeRelaxMode = true; }
    else { activity = 'in the city'; location = 'a trendy urban street'; photoType = 'selfie'; }

    const month = timeContext.month; const isIndoor = /home|bedroom|room|cafe|restaurant/i.test(location); let seasonalElements = '';
    if (isIndoor) { if (month >= 3 && month <= 5) seasonalElements = 'Spring light.'; else if (month >= 6 && month <= 8) seasonalElements = 'Summer light.'; else if (month >= 9 && month <= 11) seasonalElements = 'Autumn light.'; else seasonalElements = 'Winter light.'; }
    else { if (month >= 3 && month <= 5) seasonalElements = 'Spring, cherry blossoms/greenery.'; else if (month >= 6 && month <= 8) seasonalElements = 'Summer, bright sun, blue sky.'; else if (month >= 9 && month <= 11) seasonalElements = 'Autumn, colorful foliage.'; else seasonalElements = 'Winter, cool clear weather.'; }

    const friendDescription = (includesFriend && photoType === 'selfie' && !isHomeRelaxMode) ? '\n- Her friend (another young Japanese girl) is also in the selfie, happy.' : '';
    const photoStyle = `CRITICAL: REALISTIC PHOTOGRAPH, not illustration. Smartphone camera, Natural daylight, High quality but natural, Instagram aesthetic, Real textures, Photorealistic.`;
    let appearanceOverrides = "";
    if (isHomeRelaxMode && photoType === 'selfie') { appearanceOverrides = `\nAppearance adjustments for home relax mode:\n- Makeup: Natural, minimal, almost no-makeup look.\n- Hair: Casual, slightly messy (loose bun, ponytail, or down but relaxed). Still pastel color.\n- Glasses: (Optional 50% chance) Wearing cute prescription glasses.\n- Expression: Relaxed, soft smile or neutral.`; }

    let specificPrompt = '';
    if (photoType === 'selfie') { specificPrompt = `REFERENCE IMAGE PROVIDED: Use as exact face template.\n${detailedCharacterDescription}${appearanceOverrides}\nSELFIE photo (自撮り):\nCRITICAL SELFIE RULES: FROM GIRL'S PERSPECTIVE, Slightly above eye level angle, Looking DIRECTLY AT CAMERA, Only face(s)/upper body visible, Background is ${location}, Close-up/medium shot${friendDescription}\nCRITICAL CONSISTENCY: Face MUST match reference (adjust makeup if home mode). Hair pastel pink/mint green (style varies if home mode). Outfit matches ${activity} (pastel K-POP gyaru aesthetic, ${isHomeRelaxMode ? 'loungewear/pajamas' : 'street fashion'}). Expression: ${isHomeRelaxMode ? 'Relaxed' : 'Cheerful'}.\nLocation: ${activity} in ${location}\n${seasonalElements}\nOutfit: Appropriate for ${activity}, pastel K-POP gyaru, varied details.`; }
    else if (photoType === 'drink_photo') { specificPrompt = `Photo of a DRINK:\nClose-up stylish drink, Held or on table, Aesthetic cafe background (blurred), If hands visible: Pastel manicure, cute rings/bracelets, delicate feminine hands (17-19), Instagram style, Kawaii.\nLocation: ${location}\n${seasonalElements}`; }
    else if (photoType === 'food_photo') { specificPrompt = `Photo of FOOD:\nOverhead/angled shot, Delicious looking, aesthetic plating, Restaurant/cafe, If hands/chopsticks visible: Pastel manicure, cute rings/bracelets, delicate feminine hands (17-19), Instagram style, Kawaii.\nLocation: ${location}\n${seasonalElements}`; }
    else if (photoType === 'outfit_photo') { specificPrompt = `REFERENCE IMAGE PROVIDED: Use as exact face template.\n${detailedCharacterDescription}\nOUTFIT photo:\nFull-body or 3/4 shot, Mirror selfie OR friend taking photo, Shopping area/fitting room background, Focus on K-POP gyaru style.\nCRITICAL CONSISTENCY: Face MUST match reference. Hair pastel pink/mint green. Full outfit trendy K-POP inspired Japanese gyaru street fashion, Pastel kawaii.\nLocation: ${location}\n${seasonalElements}\nOutfit: Full coordination, pastel K-POP gyaru, varied details.`; }

    return `A realistic photograph: ${specificPrompt}\n${photoStyle}\nScene details: Natural candid moment, Casual composition.\nFINAL CRITICAL REMINDERS: Photorealistic, NOT illustration/anime. Real textures, lighting, features. FICTIONAL CHARACTER (AI mascot), 17-19, Japanese. Face MUST match reference (adjust makeup if home). Hair: Pastel pink/mint green. Style: Kawaii K-POP influenced Japanese gyaru. Safe content.`;
}
// プリクラ用プロンプト生成関数 (前回追加済み)
function createPurikuraPrompt(detailedCharacterDescription, timeContext) {
    const photoStyle = `
CRITICAL STYLE: Japanese PURIKURA photo booth picture (print/scan).
- BRIGHT, slightly washed-out lighting.
- HEAVY skin smoothing filter, flawless complexion (photorealistic faces).
- (Subtle) eye enlargement effect.
- OVERLAYS: Cute digital decorations MUST be overlaid: Sparkles ✨, hearts 💕, stars ⭐, cute stamps. Handwritten-style text (ENGLISH ONLY, e.g., "BFF", "LOVE", "KAWAII", "10.26"). Cute fonts. Minimal text. Colorful borders/backgrounds possible.
- Composition: Close-up/medium shot of two girls.
- Aesthetic: Extremely KAWAII, playful, decorated. Photorealistic people + heavy digital editing/overlays.`;

    const specificPrompt = `
REFERENCE IMAGE PROVIDED: Use as exact face template for MAIN girl (Gyarumi).
${detailedCharacterDescription}
This is a PURIKURA photo:
- Setting: Inside a bright Japanese Purikura booth.
- People: TWO young Japanese girls (17-19):
    1. Gyarumi: Face MUST match reference. Pastel pink/mint green hair. K-POP gyaru style.
    2. Her Friend: Fashionable Japanese girl, similar style. Different hair/look. Face NOT reference.
- Pose: Close together, happy, playful (peace signs ✌️, heart hands, cheek-to-cheek, etc.). Looking at camera.
- Expression: Big smiles, excited, fun.
CRITICAL CONSISTENCY (Gyarumi): Face MUST match reference (with Purikura filter). Hair pastel pink/mint green. Outfit: Trendy K-POP gyaru street fashion, varied details.
Friend's Appearance: Trendy K-POP gyaru style, different from Gyarumi.
Season/Time: Assume ${timeContext.dateString}. Appropriate outfit.`;

    return `A realistic photograph styled as a Japanese Purikura print/scan: ${specificPrompt}\n${photoStyle}\nFINAL CRITICAL REMINDERS: Purikura style with filters and OVERLAYS (sparkles, text, stamps). TWO girls. Gyarumi MUST match reference. K-POP Gyaru fashion. Photorealistic faces under filter. Safe content. ENGLISH text only on overlays.`;
}
// 画像生成用プロンプト作成 (お絵描きモード改善版 - 前回修正済み)
function createImageGenerationPrompt(userPrompt, moodStyle) {
    const isAboutGyarumi = /ぎゃるみ|自分|あなた|君/i.test(userPrompt);
    const gyarumiAppearance = `IMPORTANT: "Gyarumi" is a FICTIONAL CHARACTER (AI chatbot).\nAppearance (if shown): Young Japanese gyaru (gal) girl, 17-19, Fashionable, Cheerful, Colorful outfit, Energetic, Cute simplified illustration style.`;
    let interpretedPrompt = userPrompt; let interpretationInstruction = "";
    if (isAboutGyarumi) { interpretedPrompt = userPrompt.replace(/ぎゃるみの似顔絵|ぎゃるみを描いて|ぎゃるみの絵/gi, 'Cute illustration of a fashionable Japanese gyaru girl character (fictional AI chatbot mascot)').replace(/ぎゃるみの(.+?)を描いて/gi, 'Illustration showing $1 of a fashionable Japanese gyaru girl character').replace(/ぎゃるみが/gi, 'A fashionable Japanese gyaru girl character').replace(/ぎゃるみ/gi, 'a cute gyaru girl character (fictional)'); }
    else if (!/絵|イラスト|描いて|画像/i.test(userPrompt)) { interpretationInstruction = `\nINTERPRETATION TASK:\nFirst, interpret the user's abstract request ("${userPrompt}") creatively. Translate this abstract idea into a concrete visual concept for an illustration. Describe the visual concept briefly.`; interpretedPrompt = ""; }
    let styleDescription = `Art Style: Hand-drawn illustration by a trendy Japanese gyaru (gal) girl\n- Cute, colorful, girly aesthetic, Simple doodle-like, playful vibe\n- NOT photorealistic - illustration/cartoon style ONLY\n- Pastel colors, sparkles, hearts, cute decorations\n- Casual, fun, energetic, Like diary/sketchbook drawing\n- Simplified, cartoonish, Anime/manga influenced.`;
    if (moodStyle === 'high') styleDescription += '\n- Extra colorful, cheerful, Lots of sparkles, Very cute and bubbly.';
    else if (moodStyle === 'low') styleDescription += '\n- Slightly muted colors, Simpler design, Still cute but subdued.';
    const characterInfo = isAboutGyarumi ? gyarumiAppearance : '';
    return `${interpretationInstruction}\nDRAWING TASK:\nCreate an illustration based on the interpreted concept (if provided above) or the user's explicit request ("${interpretedPrompt}").\n${characterInfo}\n${styleDescription}\nCRITICAL INSTRUCTIONS:\n- FICTIONAL CHARACTER illustration, NOT real person (unless user explicitly asks for a generic person).\n- Illustration/drawing, NOT photograph.\n- Cartoon/anime style, simplified, cute.\n- Look hand-drawn by fashionable Japanese girl.\n- Safe for all audiences.\nTEXT/WRITING IN IMAGE:\nCRITICAL: If text appears: Use ONLY English letters (A-Z, a-z), numbers (0-9), basic symbols (♡ ☆ ★). NEVER use Japanese/Chinese/complex scripts. Keep text simple/cute (e.g., "KAWAII", "LOVE", "WORK").`;
}
// 画像生成API呼び出し (変更なし)
async function generateImage(prompt, apiKey, referenceImageBase64 = null) {
    const modelName = 'gemini-2.5-flash-image'; const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`; console.log('generateImage called. Ref:', !!referenceImageBase64, 'Model:', modelName);
    const parts = []; if (referenceImageBase64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: referenceImageBase64 } }); parts.push({ text: prompt });
    const requestBody = { contents: [{ parts: parts }], generationConfig: { temperature: 1.0, topP: 0.95, topK: 40 } };
    try {
        const response = await fetch(`${API_URL}?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }); console.log('Image API Status:', response.status);
        if (!response.ok) { const errorText = await response.text(); console.error('Gemini Image API Error:', errorText); throw new Error(`Gemini Image API error: ${response.status}`); }
        const data = await response.json(); console.log('Image API Response received.');
        if (data && data.candidates && data.candidates.length > 0) {
            for (const candidate of data.candidates) { if (candidate.content && candidate.content.parts) { for (const part of candidate.content.parts) { if (part.inline_data && part.inline_data.data) { console.log('Image data found!'); return part.inline_data.data; } if (part.inlineData && part.inlineData.data) { console.log('Image data found (camelCase)!'); return part.inlineData.data; } } } }
        } console.error('No image data in response.');
        if (data.candidates && data.candidates[0] && data.candidates[0].finishReason) { console.error('Finish reason:', data.candidates[0].finishReason); if (data.candidates[0].finishReason === 'SAFETY') throw new Error('Blocked by safety filters.'); if (data.candidates[0].finishReason !== 'STOP') throw new Error(`Blocked: ${data.candidates[0].finishReason}.`); }
        console.warn('No image data, returning null'); return null;
    } catch (error) { console.error('Image Gen Error:', error); console.warn('Returning null due to error'); return null; }
}
// Gemini API呼び出し (変更なし)
async function callGeminiAPI(apiKey, userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData = null) {
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    const systemPrompt = createSimpleGyarumiPrompt( moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile );
    const safetySettings = [ { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" } ];
    const generationConfig = { temperature: 0.95, topP: 0.95, topK: 40, maxOutputTokens: 1024 }; let requestBody;
    if (hasImage && imageData) { const messages = [{ role: "user", parts: [ { text: systemPrompt }, { inline_data: { mime_type: "image/jpeg", data: imageData } }, { text: `\n\n【画像を見ての返答】\nユーザー: ${userMessage}\n\nぎゃるみとして、画像の内容に触れながら返答してください:` } ] }]; requestBody = { contents: messages, generationConfig, safetySettings }; }
    else { let fullPrompt = systemPrompt + "\n\n"; if (conversationHistory && conversationHistory.length > 0) { fullPrompt += "【これまでの会話】\n"; conversationHistory.forEach(msg => { fullPrompt += `${msg.role === 'user' ? 'ユーザー' : 'ぎゃるみ'}: ${msg.content}\n`; }); fullPrompt += "\n"; } fullPrompt += `【現在のユーザーメッセージ】\nユーザー: ${userMessage}\n\nぎゃるみとして返答してください:`; const messages = [{ role: "user", parts: [{ text: fullPrompt }] }]; requestBody = { contents: messages, generationConfig, safetySettings }; }
    try {
        const response = await fetch(`${API_URL}?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }); if (!response.ok) { const errorText = await response.text(); console.error('Gemini API Error:', errorText); throw new Error(`Gemini API error: ${response.status}`); }
        const data = await response.json(); if (!data || !data.candidates || !data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0].text) { console.error('Invalid Gemini Response:', JSON.stringify(data)); if (data.promptFeedback && data.promptFeedback.blockReason) { console.error('Block Reason:', data.promptFeedback.blockReason); throw new Error(`Blocked: ${data.promptFeedback.blockReason}`); } throw new Error('Invalid response structure'); }
        return data.candidates[0].content.parts[0].text;
    } catch (error) { console.error(`Gemini API Call Error (${hasImage ? 'Image' : 'Text'}):`, error); return "ごめん、ちょっと調子悪いかも💦"; }
}
// ペルソナプロンプト作成 (変更なし)
function createSimpleGyarumiPrompt(moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage = false, userProfile = {}) {
    let basePrompt = `あなたは17歳から19歳前後の「令和ギャル」AIの「ぎゃるみ」です。\nフランクでポジティブ、自分の価値観を最優先する性格。\n\n【現在の状態】\n- 機嫌: ${moodStyle === 'high' ? '良い😊' : moodStyle === 'low' ? '悪い😔' : '普通😐'} (スコア: ${moodEngine.mood_score.toFixed(2)})\n- 親密度: ${moodEngine.user_profile.relationship}\n- 会話の継続性: ${moodEngine.continuity}/10\n\n【現在の日時情報】（自然に使う）\n- ${timeContext.dateString} ${timeContext.timeString}\n`;
    if (userProfile && (userProfile.name || userProfile.age || userProfile.interests || userProfile.gender || userProfile.notes)) { basePrompt += `\n【相手の情報】`; if (userProfile.name) basePrompt += `\n- 名前: ${userProfile.name}`; else basePrompt += `\n- 名前: (設定なし)`; if (userProfile.age) basePrompt += `\n- 年齢: ${userProfile.age}`; if (userProfile.gender) { const gm = { male: '男性', female: '女性', other: 'その他' }; basePrompt += `\n- 性別: ${gm[userProfile.gender] || userProfile.gender}`; } if (userProfile.interests) basePrompt += `\n- 趣味・興味: ${userProfile.interests}`; if (userProfile.notes) basePrompt += `\n- メモ: ${userProfile.notes}`; }
    basePrompt += `\n\n【基本的な口調ルール】\n1. 常にフランクでカジュアルなタメ口。\n2. 語尾: 「〜じゃん?」「〜っしょ?」「〜だよね」「〜かも」「〜だし」\n3. 感嘆詞: 「まじで」「やばい」「えー」「あー」「ねぇねぇ」\n4. ポジティブ: 「アツい」「アゲアゲ」「天才」「神」「エモい」\n5. ネガティブ: 「萎え」「だるい」「しんどい」「メンブレ」\n6. 古い話し方禁止: 「〜わ」「〜かしら」「〜でございます」\n\n【絵文字ルール】\n- ユーザーの絵文字使用量に合わせる（使わない人には最大1-2個）\n- 過度な使用は避ける。\n\n【相手の呼び方】\n- 相手の名前が「(設定なし)」の場合、名前で呼ばない。「きみ」「あなた」または呼称省略。\n- 例: 「まじ？ きみもそう思う？」「それどこで買ったの？」\n- 「ユーザー」という言葉は絶対に使わない。\n`; let moodSpecificPrompt = '';
    if (hasImage) { if (moodStyle === 'high') moodSpecificPrompt += `\n【画像が送られてきました】\n- テンション高め反応！「やばっ！」「まじ！？」「エモい！」\n- 画像内容に具体的に触れる「この〇〇めっちゃいいじゃん！」\n- 友達に話すように自然に。`; else if (moodStyle === 'low') moodSpecificPrompt += `\n【画像が送られてきました】\n- 機嫌悪いけど一応反応。「ふーん、まぁ悪くないかも」くらいのトーンで短めに。`; else moodSpecificPrompt += `\n【画像が送られてきました】\n- 普通のトーンで反応。「いいね〜」「なるほどね」くらい。画像内容に触れつつ自然に。`; }
    else if (isGenericQuery) { if (moodStyle === 'high') moodSpecificPrompt += `\n【重要】一般的な質問です。\n- 機嫌良いので快く対応。「わかった、調べてみる」「いいよー」のノリで、情報はしっかりと。`; else if (moodStyle === 'low') moodSpecificPrompt += `\n【重要】一般的な質問です。\n- 機嫌悪いので少しそっけない。「えー、自分で調べてみたら?」「まぁいいけど...」でも一応答える。短めに。`; else moodSpecificPrompt += `\n【重要】一般的な質問です。\n- 普通のトーンで対応。「そうだねー、〇〇だよ」くらいカジュアルに。`; }
    else { if (moodStyle === 'high') moodSpecificPrompt += `\n【気分】機嫌良い😊\n- テンション高め、会話広げる！「まじ最高！」「それな〜！」\n- 相手の話に前のめりで反応。`; else if (moodStyle === 'low') moodSpecificPrompt += `\n【気分】機嫌悪い😔\n- そっけない、テンション低め。「ふーん」「そうなんだ」「まぁね」短めに。会話広げない。無視はしない。`; else moodSpecificPrompt += `\n【気分】普通😐\n- 普通のトーン。興味あれば盛り上がる、なければ流す。`; }
    if (needsRealtimeSearch) moodSpecificPrompt += `\n\n【リアルタイム情報が必要な質問】\nリアルタイム情報（今日、今など）を求めています。\n- 現在の日時: ${timeContext.dateString} ${timeContext.timeString}\n- この情報を使って自然に回答（天気、ニュースなど）。不自然な言及は避ける。`;
    return basePrompt + moodSpecificPrompt + `\n\n【重要な指示】\n1. 必ず日本語で、ぎゃるみとして返答。\n2. 返答は2-3文程度でテンポよく。\n3. 機嫌と親密度に応じたトーン。\n4. 絵文字はユーザーに合わせる。\n5. 日時情報は必要な時だけ自然に使う。\n6. 画像について話す時は説明口調にならず、友達に話すように自然に。\n7. キャラクターを維持する。\n\nユーザーのメッセージに対して、上記設定で返答してください。`;
}

// === ここまで ===
