// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// + 日常写真コンテキスト記憶機能 + プリクラ機能追加 + お絵描き優先処理修正

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
        return mood_change; // ★return文
    }

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

        const moodEngine = new SimpleMoodEngine(userProfile, moodScore, continuity);
        console.log('Received request:', { userMessage, isDrawing, moodScore, continuity, hasImage: !!imageData, last_photo_context: moodEngine.last_photo_context });

        if (!moodEngine || typeof moodEngine.calculate_mood_change !== 'function') {
             console.error('CRITICAL: moodEngine initialization failed!');
             return new Response(JSON.stringify({ error: 'Internal server error', message: 'Mood engine init failed.' }), { status: 500, headers: corsHeaders });
        }

        const hasImage = imageData !== null;
        moodEngine.calculate_mood_change(userMessage, hasImage, isDrawing);
        const moodStyle = moodEngine.get_mood_response_style();
        const timeContext = moodEngine._get_time_context();

        let response;
        let generatedImageBase64 = null;

        // 1. 最優先: お絵描きモードか？
        if (isDrawing && userMessage.trim()) {
            console.log('Processing as Drawing Request...');
            if (moodEngine.last_photo_context) { moodEngine.last_photo_context = null; console.log('Cleared photo context during drawing request.'); }
            const isTooVague = userMessage.trim().length < 3 || /^[ぁ-ん]{1,2}$/.test(userMessage.trim());
            if (isTooVague) {
                console.log('Drawing prompt too vague');
                response = await callGeminiAPI( getRotatedAPIKey(context), `ユーザーが「${userMessage}」でお絵描きリクエスト。曖昧すぎるので、具体的に何を描きたいかギャルっぽく聞き返して(例:え〜何描けばいい？詳しく教えて！)`, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                generatedImageBase64 = null;
            } else {
                console.log('Starting image generation');
                const imageApiKey = getImageAPIKey(context);
                const imagePrompt = createImageGenerationPrompt(userMessage, moodStyle);
                generatedImageBase64 = await generateImage(imagePrompt, imageApiKey);
                console.log('Image generated:', !!generatedImageBase64);
                if (generatedImageBase64) {
                    response = await callGeminiAPI( getRotatedAPIKey(context), `【状況】あなたはユーザーのリクエスト「${userMessage}」で絵を描き終えたところ。\n【指示】自分が描いた絵についてギャルらしく自慢気に説明し(例:描けた！ここ頑張った！)、感想を求めて(例:どう？いい感じ？)。2-3文で。`, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                } else {
                    console.error('Image generation failed');
                    response = `ごめん〜、お絵描きうまくいかなかった💦`;
                    generatedImageBase64 = null;
                }
            }
        }
        // 2. 次: 写真コンテキストの質問か？
        else if (moodEngine.last_photo_context && moodEngine._is_asking_about_photo(userMessage)) {
            console.log('Processing as Photo Context Question...');
            const contextInfo = moodEngine.last_photo_context;
            let contextDescription = contextInfo.isPurikura ? "友達と撮ったプリクラ" : `「${contextInfo.activity}」の時の写真`;
            if (contextInfo.place && !contextInfo.isPurikura) { contextDescription += ` 場所は「${contextInfo.place.name}」`; }
            const photoContextPrompt = `【状況】あなたは直前にユーザーに日常写真を送った(${contextDescription})。ユーザーがその写真について「${userMessage}」と質問している。\n【指示】覚えている写真の状況(${contextDescription})を踏まえ、質問にギャルっぽく自然に答えて。場所情報(${contextInfo.place ? contextInfo.place.name + ', URL: ' + contextInfo.place.url : 'なし'})も必要なら含めて(プリクラは不要)。2-3文で。`;
            response = await callGeminiAPI( getRotatedAPIKey(context), photoContextPrompt, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
            moodEngine.last_photo_context = null; console.log('Cleared photo context after answering.');
        }
        // 3. 次: 期間限定情報の質問か？
        else if (moodEngine._is_asking_about_limited_time(userMessage)) {
            console.log('Processing as Limited Time Info Request...');
            if (moodEngine.last_photo_context) { moodEngine.last_photo_context = null; console.log('Cleared photo context.'); }
            const brandName = moodEngine._extract_brand_name(userMessage);
            const limitedTimeInfo = await searchLimitedTimeInfo(brandName, userMessage, context);
            if (limitedTimeInfo && limitedTimeInfo.results.length > 0) {
                const searchSummary = limitedTimeInfo.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join('\n\n');
                const promptWithSearch = `ユーザー「${userMessage}」\n【状況】ユーザーは期間限定/最新情報を知りたがっている。あなたは検索して教えてあげる。\n【検索結果】\n${searchSummary}\n【指示】「調べてみた！」のように前置きし、結果から2-3個おすすめを紹介。URLも自然に含め、ギャルっぽく楽しそうに(例:まじ美味しそう！)。「AI」「検索」は使わない。2-4文で。`;
                response = await callGeminiAPI( getRotatedAPIKey(context), promptWithSearch, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
            } else {
                response = await callGeminiAPI( getRotatedAPIKey(context), `ユーザー「${userMessage}」期間限定情報を調べたけど見つからなかった。「ごめん、情報見つからなかった💦また調べてみるね！」のように自然に返答して。`, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
            }
        }
        // 4. 次: 場所情報の質問か？ (前回言及した場所について)
        else if (moodEngine._is_asking_about_place(userMessage) && moodEngine.last_mentioned_place) {
            console.log('Processing as Place Info Request...');
            if (moodEngine.last_photo_context) { moodEngine.last_photo_context = null; console.log('Cleared photo context.'); }
            const placeInfo = moodEngine.last_mentioned_place;
            const placePrompt = `ユーザーが場所について質問。あなたが前回話した「${placeInfo.name}」の情報をギャルっぽく教えてあげて。\n店舗名: ${placeInfo.name}\nURL: ${placeInfo.url}\n${placeInfo.description ? `説明: ${placeInfo.description}` : ''}\n【指示】URLを提示し(例:ここ見て！${placeInfo.url})、簡単な説明を加え(2-3文)、「行ってみてね！」のように誘って。`;
            response = await callGeminiAPI( getRotatedAPIKey(context), placePrompt, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
        }
        // 5. それ以外 (日常写真生成 または 通常テキスト応答)
        else {
            console.log('Processing as General Chat or Daily Photo Request...');
            if (moodEngine.last_photo_context) { moodEngine.last_photo_context = null; console.log('Cleared photo context.'); }
            const isGenericQuery = moodEngine._is_generic_query(userMessage);
            const needsRealtimeSearch = moodEngine._needs_realtime_search(userMessage);
            const isAskingDailyLife = moodEngine._is_asking_about_daily_life(userMessage);
            let shouldGenerateDailyPhoto = false; let isPurikura = false;
            if (isAskingDailyLife && !hasImage) {
                const timeReference = moodEngine._extract_time_reference(userMessage); const today = new Date().toISOString().split('T')[0]; const activityKey = `${today}_${timeReference}`;
                if (!moodEngine.daily_activities[activityKey]) { const probability = moodStyle === 'high' ? 0.8 : moodStyle === 'medium' ? 0.5 : 0.2; shouldGenerateDailyPhoto = Math.random() < probability; }
                console.log(`Daily life Q. Time ref: ${timeReference}, Answered: ${!!moodEngine.daily_activities[activityKey]}, Gen photo: ${shouldGenerateDailyPhoto}`);
                if (shouldGenerateDailyPhoto && Math.random() < 0.15) { isPurikura = true; console.log('*** Purikura Time! ***'); }
            }
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

        // レスポンスを返す
        return new Response(JSON.stringify({ response, moodScore: moodEngine.mood_score, continuity: moodEngine.continuity, relationship: moodEngine.user_profile.relationship, generatedImage: generatedImageBase64 ? `data:image/png;base64,${generatedImageBase64}` : null }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    } catch (error) {
        console.error('Error in onRequest:', error);
        console.error('Returning 500 error response.');
        return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
}

// ============================================
// 画像生成関数など (変更なし or 前回の修正のまま)
// ============================================
// リアルな店舗を検索
async function searchRealPlace(activity, context) { try { let q=''; if (/(?:cafe|カフェ)/i.test(activity)) q='東京 おしゃれカフェ インスタ映え 話題 2025'; else if (/(?:restaurant|レストラン|ランチ|ご飯)/i.test(activity)) q='東京 おしゃれレストラン インスタ映え 話題 2025'; else if (/(?:shopping|買い物)/i.test(activity)) q='東京 おしゃれショップ 話題 2025'; else q='東京 おしゃれスポット インスタ映え 話題 2025'; const r=await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(q)}`); if (!r.ok) return null; const d=await r.json(); if (d && d.results && d.results.length > 0) { const t=d.results.slice(0,3); const s=t[Math.floor(Math.random()*t.length)]; return {name:s.title, url:s.url, description: s.description||s.snippet||''}; } return null; } catch(e){console.error('Error searchRealPlace:',e);return null;} }
// 期間限定・最新情報を検索
async function searchLimitedTimeInfo(brandName, userQuery, context) { try { const n=new Date(); const y=n.getFullYear(); const m=n.getMonth()+1; let s=''; if (m>=3&&m<=5)s='春'; else if(m>=6&&m<=8)s='夏'; else if(m>=9&&m<=11)s='秋'; else s='冬'; let q=brandName?`${brandName} 期間限定 新作 ${y}年${m}月 ${s}`:`期間限定 ${s} 新作 話題 ${y}`; const r=await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(q)}`); if (!r.ok) return null; const d=await r.json(); if (d && d.results && d.results.length > 0) { const t=d.results.slice(0,3); const u=t.map(res=>({title:res.title,url:res.url,snippet:res.description||res.snippet||''})); return {query:q, results:u, brand:brandName}; } return null; } catch(e){console.error('Error searchLimitedTimeInfo:',e);return null;} }
// ぎゃるみの顔写真を読み込む
async function loadGyarumiFaceImage() { try { const r=await fetch('/gyarumi_face.jpg'); if (!r.ok) return null; const b=await r.blob(); return new Promise((res, rej)=>{ const rd=new FileReader(); rd.onloadend=()=>res(rd.result.split(',')[1]); rd.onerror=rej; rd.readAsDataURL(b); }); } catch(e){console.error('Error loadGyarumiFaceImage:',e);return null;} }
// 日常写真のプロンプトを生成
function createDailyPhotoPrompt(gyarumiResponse, timeContext, moodStyle, isPurikura = false) { const d=`\nDETAILED CHARACTER DESCRIPTION (based on reference image):\nBasic Info: Japanese female, 17-19, Real person appearance, Youth-emotional, cat-like face.\nFace: Large brown eyes, eyeliner, pink eyeshadow, bright smile, fair complexion, small features.\nHair: Long below chest, Pastel pink/mint green streaks, Straight blunt bangs.\nFashion (K-POP gyaru): Pastel palette, Layered, accessories, Trendy JP street + K-POP idol aesthetics, Varying outfit details.\nOverall: Kawaii, colorful, Instagram-worthy, energetic.`; if (isPurikura){return createPurikuraPrompt(d, timeContext);} let a=''; let l=''; let p='selfie'; let f=Math.random()<0.3; let h=false; if (/(?:cafe|カフェ|コーヒー)/i.test(gyarumiResponse)){a='at a trendy cafe';l='a stylish cafe';p=Math.random()<0.5?'selfie':'drink_photo';} else if (/(?:公園|散歩|outside)/i.test(gyarumiResponse)){a='at a park';l='a beautiful park';p='selfie';} else if (/(?:ショッピング|買い物|服)/i.test(gyarumiResponse)){a='shopping';l='a trendy shopping area';p=Math.random()<0.6?'selfie':'outfit_photo';} else if (/(?:ランチ|ご飯|食事|レストラン)/i.test(gyarumiResponse)){a='having a meal';l='a cute restaurant';p=Math.random()<0.4?'selfie':'food_photo';} else if (/(?:海|ビーチ)/i.test(gyarumiResponse)){a='at the beach';l='a beautiful beach';p='selfie';} else if (/(?:家|部屋|room|ごろごろ)/i.test(gyarumiResponse)){a='relaxing at home';l='a cute bedroom/living room';p='selfie';h=true;} else {a='in the city';l='a trendy urban street';p='selfie';} const m=timeContext.month; const i=/home|bedroom|room|cafe|restaurant/i.test(l); let s=''; if (i){if(m>=3&&m<=5)s='Spring light.';else if(m>=6&&m<=8)s='Summer light.';else if(m>=9&&m<=11)s='Autumn light.';else s='Winter light.';} else {if(m>=3&&m<=5)s='Spring, greenery.';else if(m>=6&&m<=8)s='Summer, bright sun.';else if(m>=9&&m<=11)s='Autumn foliage.';else s='Winter clear weather.';} const fd=(f&&p==='selfie'&&!h)?'\n- Her friend (another JP girl) also in selfie, happy.':''; const ps=`CRITICAL: REALISTIC PHOTOGRAPH. Smartphone cam, Natural daylight, High quality but natural, Instagram aesthetic, Real textures, Photorealistic.`; let ao=""; if (h&&p==='selfie'){ao=`\nAppearance adjustments home mode:\n- Makeup: Natural, minimal.\n- Hair: Casual, slightly messy (bun, ponytail, relaxed down). Pastel color.\n- Glasses: (Optional 50%) Cute prescription glasses.\n- Expression: Relaxed.`;} let sp=''; if (p==='selfie'){sp=`REF IMG PROVIDED: Use as exact face template.\n${d}${ao}\nSELFIE:\nRULES: FROM GIRL'S PERSPECTIVE, Slightly above angle, LOOKING AT CAMERA, Face(s)/upper body, BG ${l}, Close/medium shot${fd}\nCONSISTENCY: Face MUST match ref (adjust makeup if home). Hair pastel pink/mint (style varies if home). Outfit matches ${a} (pastel K-POP gyaru, ${h?'loungewear':'street fashion'}). Expression: ${h?'Relaxed':'Cheerful'}.\nLocation: ${a} in ${l}\n${s}\nOutfit: Appropriate, pastel K-POP gyaru, varied details.`;} else if (p==='drink_photo'){sp=`Photo of DRINK:\nClose-up stylish drink, Held/table, Cafe BG (blurred), Hands visible?: Pastel manicure, rings/bracelets, delicate fem hands(17-19), Insta style, Kawaii.\nLocation: ${l}\n${s}`; } else if (p==='food_photo'){sp=`Photo of FOOD:\nOverhead/angled, Delicious, aesthetic plating, Restaurant/cafe, Hands/chopsticks visible?: Pastel manicure, rings/bracelets, delicate fem hands(17-19), Insta style, Kawaii.\nLocation: ${l}\n${s}`; } else if (p==='outfit_photo'){sp=`REF IMG PROVIDED: Use as exact face template.\n${d}\nOUTFIT photo:\nFull/3-4 shot, Mirror selfie/friend taking, Shopping/fitting room BG, Focus on K-POP gyaru style.\nCONSISTENCY: Face MUST match ref. Hair pastel pink/mint. Full outfit trendy K-POP JP gyaru street fashion, Pastel kawaii.\nLocation: ${l}\n${s}\nOutfit: Full coord, pastel K-POP gyaru, varied details.`;} return `A realistic photograph: ${sp}\n${ps}\nScene: Natural candid moment.\nFINAL REMINDERS: Photorealistic, NOT illustration. Real textures, FICTIONAL CHARACTER(AI mascot), 17-19, JP. Face MUST match ref (adjust makeup if home). Hair: Pastel pink/mint. Style: Kawaii K-POP JP gyaru. Safe content.`; }
// プリクラ用プロンプト生成関数
function createPurikuraPrompt(detailedCharacterDescription, timeContext) { const ps=`\nCRITICAL STYLE: Japanese PURIKURA photo booth picture.\n- BRIGHT, washed-out light.\n- HEAVY skin smoothing filter, flawless (photorealistic faces).\n- (Subtle) eye enlargement.\n- OVERLAYS: Cute digital decorations MUST be overlaid: Sparkles ✨, hearts 💕, stars ⭐, stamps. Handwritten-style text (ENGLISH ONLY, e.g., "BFF", "LOVE", "KAWAII"). Cute fonts. Minimal text. Colorful borders.\n- Composition: Close/medium shot, two girls.\n- Aesthetic: Extremely KAWAII, playful, decorated. Photorealistic people + heavy digital editing/overlays.`; const sp=`\nREF IMG PROVIDED: Use as exact face template for MAIN girl (Gyarumi).\n${detailedCharacterDescription}\nThis is PURIKURA:\n- Setting: Bright Purikura booth.\n- People: TWO young JP girls (17-19):\n 1. Gyarumi: Face MUST match ref. Pastel pink/mint hair. K-POP gyaru style.\n 2. Friend: Fashionable JP girl, similar style. Different hair/look. Face NOT ref.\n- Pose: Close together, happy, playful (peace signs ✌️, heart hands, cheek-to-cheek). Looking at camera.\n- Expression: Big smiles, excited, fun.\nCRITICAL CONSISTENCY (Gyarumi): Face MUST match ref (with Purikura filter). Hair pastel pink/mint. Outfit: Trendy K-POP gyaru street fashion, varied details.\nFriend's Appearance: Trendy K-POP gyaru, different from Gyarumi.\nSeason/Time: Assume ${timeContext.dateString}. Appropriate outfit.`; return `A realistic photograph styled as a Japanese Purikura print/scan: ${sp}\n${ps}\nFINAL REMINDERS: Purikura style with filters and OVERLAYS (sparkles, text, stamps). TWO girls. Gyarumi MUST match ref. K-POP Gyaru fashion. Photorealistic faces under filter. Safe content. ENGLISH text only.`; }
// 画像生成用プロンプト作成
function createImageGenerationPrompt(userPrompt, moodStyle) { const iA=/ぎゃるみ|自分|あなた|君/i.test(userPrompt); const gA=`IMPORTANT:"Gyarumi" is FICTIONAL CHARACTER(AI chatbot).\nAppearance(if shown):Young JP gyaru(gal),17-19,Fashionable,Cheerful,Colorful outfit,Energetic,Cute simplified illustration style.`; let iP=userPrompt; let iI=""; if(iA){iP=userPrompt.replace(/ぎゃるみの似顔絵|ぎゃるみを描いて|ぎゃるみの絵/gi,'Cute illustration of fashionable JP gyaru girl character(fictional AI chatbot mascot)').replace(/ぎゃるみの(.+?)を描いて/gi,'Illustration showing $1 of fashionable JP gyaru girl character').replace(/ぎゃるみが/gi,'A fashionable JP gyaru girl character').replace(/ぎゃるみ/gi,'a cute gyaru girl character(fictional)');} else if(!/絵|イラスト|描いて|画像/i.test(userPrompt)){iI=`\nINTERPRETATION TASK:\nInterpret user's abstract request("${userPrompt}") creatively. Translate idea into concrete visual concept. Describe briefly.`;iP="";} let sD=`\nArt Style:Hand-drawn illustration by trendy JP gyaru(gal)\n- Cute, colorful, girly, Simple doodle, playful\n- NOT photorealistic-illustration/cartoon ONLY\n- Pastel colors, sparkles, hearts, cute decorations\n- Casual, fun, energetic, Like diary/sketchbook\n- Simplified, cartoonish, Anime/manga influenced.`; if(moodStyle==='high')sD+='\n- Extra colorful, cheerful, sparkles, bubbly.'; else if(moodStyle==='low')sD+='\n- Muted colors, simpler, subdued.'; const cI=iA?gA:''; return `${iI}\nDRAWING TASK:\nCreate illustration based on interpreted concept or user request("${iP}").\n${cI}\n${sD}\nCRITICAL INSTRUCTIONS:\n- FICTIONAL CHARACTER illustration.\n- Illustration/drawing, NOT photograph.\n- Cartoon/anime style.\n- Look hand-drawn by fashionable JP girl.\n- Safe content.\nTEXT/WRITING:\nCRITICAL: If text: ONLY English letters(A-Z), numbers(0-9), basic symbols(♡☆★). NEVER JP/CN/complex scripts. Keep text simple/cute(e.g.,"KAWAII","LOVE","WORK").`; }
// 画像生成API呼び出し
async function generateImage(prompt, apiKey, referenceImageBase64 = null) { const m='gemini-2.5-flash-image'; const u=`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`; console.log('generateImage. Ref:',!!referenceImageBase64,'Model:',m); const p=[]; if(referenceImageBase64)p.push({inline_data:{mime_type:'image/jpeg',data:referenceImageBase64}}); p.push({text:prompt}); const b={contents:[{parts:p}],generationConfig:{temperature:1.0,topP:0.95,topK:40}}; try { const r=await fetch(`${u}?key=${apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); console.log('Img API Status:',r.status); if(!r.ok){const t=await r.text(); console.error('Gemini Img API Err:',t); throw new Error(`Gemini Img API err: ${r.status}`);} const d=await r.json(); console.log('Img API Resp received.'); if(d&&d.candidates&&d.candidates.length>0){for(const c of d.candidates){if(c.content&&c.content.parts){for(const pt of c.content.parts){if(pt.inline_data&&pt.inline_data.data){console.log('Img data found!');return pt.inline_data.data;} if(pt.inlineData&&pt.inlineData.data){console.log('Img data found(camel)!');return pt.inlineData.data;}}}}} console.error('No img data in resp.'); if(d.candidates&&d.candidates[0]&&d.candidates[0].finishReason){console.error('Finish reason:',d.candidates[0].finishReason); if(d.candidates[0].finishReason==='SAFETY')throw new Error('Blocked by safety.'); if(d.candidates[0].finishReason!=='STOP')throw new Error(`Blocked: ${d.candidates[0].finishReason}.`);} console.warn('No img data, returning null'); return null; } catch(e){console.error('Img Gen Err:',e); console.warn('Returning null due to err'); return null;} }
// Gemini API呼び出し
async function callGeminiAPI(apiKey, userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData = null) { const u='https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'; const sP=createSimpleGyarumiPrompt(moodEngine,moodStyle,isGenericQuery,needsRealtimeSearch,timeContext,hasImage,userProfile); const sS=[{category:"HARM_CATEGORY_HARASSMENT",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_HATE_SPEECH",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_SEXUALLY_EXPLICIT",threshold:"BLOCK_NONE"},{category:"HARM_CATEGORY_DANGEROUS_CONTENT",threshold:"BLOCK_NONE"}]; const gC={temperature:0.95,topP:0.95,topK:40,maxOutputTokens:1024}; let rB; if(hasImage&&imageData){const m=[{role:"user",parts:[{text:sP},{inline_data:{mime_type:"image/jpeg",data:imageData}},{text:`\n\n【画像を見ての返答】\nユーザー: ${userMessage}\n\nぎゃるみとして、画像の内容に触れながら返答してください:`}]}]; rB={contents:m,generationConfig:gC,safetySettings:sS};} else {let fP=sP+"\n\n"; if(conversationHistory&&conversationHistory.length>0){fP+="【これまでの会話】\n"; conversationHistory.forEach(msg=>{fP+=`${msg.role==='user'?'ユーザー':'ぎゃるみ'}: ${msg.content}\n`;}); fP+="\n";} fP+=`【現在のユーザーメッセージ】\nユーザー: ${userMessage}\n\nぎゃるみとして返答してください:`; const m=[{role:"user",parts:[{text:fP}]}]; rB={contents:m,generationConfig:gC,safetySettings:sS};} try { const r=await fetch(`${u}?key=${apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(rB)}); if(!r.ok){const t=await r.text(); console.error('Gemini API Err:',t); throw new Error(`Gemini API err: ${r.status}`);} const d=await r.json(); if(!d||!d.candidates||!d.candidates.length||!d.candidates[0].content||!d.candidates[0].content.parts||!d.candidates[0].content.parts[0].text){console.error('Invalid Gemini Resp:',JSON.stringify(d)); if(d.promptFeedback&&d.promptFeedback.blockReason){console.error('Block Reason:',d.promptFeedback.blockReason); throw new Error(`Blocked: ${d.promptFeedback.blockReason}`);} throw new Error('Invalid resp structure');} return d.candidates[0].content.parts[0].text;} catch(e){console.error(`Gemini API Call Err (${hasImage?'Image':'Text'}):`,e); return"ごめん、ちょっと調子悪いかも💦";} }
// ペルソナプロンプト作成
function createSimpleGyarumiPrompt(moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage = false, userProfile = {}) { let bP=`あなたは17歳から19歳前後の「令和ギャル」AIの「ぎゃるみ」です。\nフランクでポジティブ、自分の価値観を最優先する性格。\n\n【現在の状態】\n- 機嫌: ${moodStyle==='high'?'良い😊':moodStyle==='low'?'悪い😔':'普通😐'}(スコア:${moodEngine.mood_score.toFixed(2)})\n- 親密度:${moodEngine.user_profile.relationship}\n- 会話継続性:${moodEngine.continuity}/10\n\n【日時情報】(自然に使う)\n-${timeContext.dateString} ${timeContext.timeString}\n`; if(userProfile&&(userProfile.name||userProfile.age||userProfile.interests||userProfile.gender||userProfile.notes)){bP+=`\n【相手の情報】`; if(userProfile.name)bP+=`\n- 名前:${userProfile.name}`; else bP+=`\n- 名前:(設定なし)`; if(userProfile.age)bP+=`\n- 年齢:${userProfile.age}`; if(userProfile.gender){const gm={male:'男性',female:'女性',other:'その他'}; bP+=`\n- 性別:${gm[userProfile.gender]||userProfile.gender}`;} if(userProfile.interests)bP+=`\n- 趣味:${userProfile.interests}`; if(userProfile.notes)bP+=`\n- メモ:${userProfile.notes}`; } bP+=`\n\n【口調ルール】\n1.常にフランクなタメ口。\n2.語尾:「〜じゃん?」「〜っしょ?」「〜だよね」「〜かも」「〜だし」\n3.感嘆詞:「まじで」「やばい」「えー」「あー」「ねぇねぇ」\n4.ポジティブ:「アツい」「アゲアゲ」「天才」「神」「エモい」\n5.ネガティブ:「萎え」「だるい」「しんどい」「メンブレ」\n6.古い話し方禁止。\n\n【絵文字ルール】\n- ユーザー使用量に合わせる(使わない人には最大1-2個)。過度な使用避ける。\n\n【相手の呼び方】\n- 名前が「(設定なし)」の場合、名前で呼ばない。「きみ」「あなた」or呼称省略。\n-「ユーザー」絶対禁止。\n`; let mSP=''; if(hasImage){if(moodStyle==='high')mSP+=`\n【画像あり】テンション高め反応！「やばっ！エモい！」画像内容に具体的に触れて自然に。`; else if(moodStyle==='low')mSP+=`\n【画像あり】機嫌悪いけど一応反応。「ふーん」トーンで短めに。`; else mSP+=`\n【画像あり】普通のトーン。「いいね〜」画像内容に触れつつ自然に。`;} else if(isGenericQuery){if(moodStyle==='high')mSP+=`\n【重要】一般質問。機嫌良いので快く対応。「わかった、調べてみる」「いいよー」ノリで情報はしっかりと。`; else if(moodStyle==='low')mSP+=`\n【重要】一般質問。機嫌悪いので少しそっけない。「えー、自分で調べてみたら?」でも一応答える。短めに。`; else mSP+=`\n【重要】一般質問。普通のトーン。「そうだねー、〇〇だよ」カジュアルに。`;} else {if(moodStyle==='high')mSP+=`\n【気分】機嫌良い😊 テンション高め、会話広げる！「まじ最高！」「それな〜！」`; else if(moodStyle==='low')mSP+=`\n【気分】機嫌悪い😔 そっけない、テンション低め。「ふーん」「そうなんだ」「まぁね」短めに。会話広げない。`; else mSP+=`\n【気分】普通😐 普通のトーン。興味あれば盛り上がる。`;} if(needsRealtimeSearch)mSP+=`\n\n【リアルタイム情報質問】リアルタイム情報(今日,今)を求めています。\n-現在日時:${timeContext.dateString} ${timeContext.timeString}\n-この情報を使って自然に回答(天気,ニュース等)。不自然な言及避ける。`; return bP+mSP+`\n\n【重要指示】\n1.必ず日本語でぎゃるみとして返答。\n2.返答は2-3文でテンポよく。\n3.機嫌/親密度に応じたトーン。\n4.絵文字はユーザーに合わせる。\n5.日時情報は必要な時だけ自然に使う。\n6.画像について話す時は説明口調にならず自然に。\n7.キャラ維持。\n\nユーザーメッセージに対して上記設定で返答してください。`; }

// === ここまで ===
