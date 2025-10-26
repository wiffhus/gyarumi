// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// シンプル化された機嫌システム + リアルタイム検索対応版 + 画像解析機能 + 画像生成機能 + APIキー自動ローテーション
// + 日常写真コンテキスト記憶機能

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
    if (hour >= 0 && hour < 6) {
        keyName = 'GEMINI_API_KEY';
    } else if (hour >= 6 && hour < 12) {
        keyName = 'GEMINI_API_KEY2';
    } else if (hour >= 12 && hour < 18) {
        keyName = 'GEMINI_API_KEY3';
    } else {
        keyName = 'GEMINI_API_KEY4';
    }
    
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
        
        // ★新規: 直前に生成した日常写真のコンテキストを記憶
        this.last_photo_context = null; // { activity: string, place: object | null }

        this.gal_friendly_keywords = [
            'まじ', '最高', 'ヤバい', 'やばい', '可愛い', 'かわいい', 'エモい', '神', 
            '好き', 'すごい', 'わかる', 'それな', 'ファッション', '服', 'コスメ', 
            'メイク', 'カフェ', 'スイーツ', '映え', '写真', 'インスタ', 'TikTok',
            '推し', 'アイドル', 'ライブ', 'フェス', '旅行', '海', 'プール', '画像', '写真', '絵'
        ];
        this.generic_ai_queries = [
            'おすすめ', 'どこ', 'どう', '何', '教えて', '調べて', 'って何', 
            '方法', 'やり方', '違い', '意味', '理由', '原因'
        ];
        
        this.user_profile = new UserProfile(userProfile);
        this.mood_score = initialMoodScore;
        this.continuity = initialContinuity;
        this.last_message_time = Date.now();
    }

    // (他のメソッド _get_now, _get_time_context, _is_generic_query などは変更なし)
    // ... (省略) ...
    // 日時を取得（JST）
    _get_now() {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        return new Date(utc + (3600000 * 9));
    }
    
    // 現在時刻情報を文字列で取得
    _get_time_context() {
        const now = this._get_now();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const weekday = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'][now.getDay()];
        
        return {
            year, month, day, hour, minute, weekday,
            dateString: `${year}年${month}月${day}日(${weekday})`,
            timeString: `${hour}時${minute}分`
        };
    }
    
    // 一般的なAIへの質問かどうか
    _is_generic_query(query) {
        const normalized = query.toLowerCase();
        return this.generic_ai_queries.some(keyword => normalized.includes(keyword));
    }
    
    // リアルタイム情報が必要な質問かどうか
    _needs_realtime_search(query) {
        const normalized = query.toLowerCase();
        const realtime_keywords = [
            '今日', '今', '現在', '最新', '天気', '気温', 'ニュース', 
            '今週', '今月', 'いま', '最近'
        ];
        return realtime_keywords.some(keyword => normalized.includes(keyword));
    }
    
    // ギャルっぽいトピックかどうか
    _is_gal_friendly_topic(query) {
        const normalized = query.toLowerCase();
        return this.gal_friendly_keywords.some(keyword => normalized.includes(keyword));
    }
    
    // ぎゃるみの日常を聞いているかどうか
    _is_asking_about_daily_life(query) {
        const normalized = query.toLowerCase();
        const dailyLifeKeywords = [
            '今日', '何してた', '何した', 'どうだった', '最近', 'どう過ごし',
            'どこ行った', 'どこ行って', '昨日', '週末', '休み', 
            'どんな感じ', 'どんなこと', '何か面白いこと', '楽しかった',
            '何してる', '何してるの', 'どうしてる', 'どうしてるの',
            '元気', 'どう', '調子', '過ごして', '一昨日', '先週',
            'この前', 'さっき', '今朝', '午前', '午後', 'バイト',
            '今何', 'いま何', 'なにしてる', 'なにしてるの', '今なに'
        ];
        return dailyLifeKeywords.some(keyword => normalized.includes(keyword));
    }
    
    // 特定の日付を聞いているか抽出
    _extract_time_reference(query) {
        const normalized = query.toLowerCase();
        if (normalized.includes('今何') || normalized.includes('今なに') || normalized.includes('いま何') || normalized.includes('何してる')) return 'right_now';
        if (normalized.includes('今日') || normalized.includes('きょう')) return 'today';
        if (normalized.includes('昨日') || normalized.includes('きのう')) return 'yesterday';
        if (normalized.includes('一昨日') || normalized.includes('おととい')) return 'day_before_yesterday';
        if (normalized.includes('週末') || normalized.includes('土曜') || normalized.includes('日曜')) return 'weekend';
        if (normalized.includes('先週') || normalized.includes('この前')) return 'last_week';
        return 'today'; // デフォルトは今日
    }
    
    // 場所情報を聞いているかどうか
    _is_asking_about_place(query) {
        const normalized = query.toLowerCase();
        const placeKeywords = [
            '場所', 'どこ', 'アクセス', '行き方', '住所', 'url', 
            'リンク', '教えて', '詳しく', '情報', 'どこにある',
            'どうやって行く', 'どこにあるの', 'どこだっけ'
        ];
        return placeKeywords.some(keyword => normalized.includes(keyword));
    }
    
    // 期間限定・最新情報を求めているか
    _is_asking_about_limited_time(query) {
        const normalized = query.toLowerCase();
        const limitedTimeKeywords = [
            '期間限定', '限定', '今なん', '今何', '最新', '新作', '新しい',
            'いまなん', 'いま何', '今の', 'セール', 'キャンペーン',
            'フェア', '今月', 'おすすめ', 'やってる', 'ある？', 'あるの',
            '今度', '次', '秋限定', '冬限定', '春限定', '夏限定'
        ];
        return limitedTimeKeywords.some(keyword => normalized.includes(keyword));
    }
    
    // ブランド・店舗名を抽出
    _extract_brand_name(query) {
        const normalized = query.toLowerCase();
        const brands = [
            'マクド', 'マック', 'マクドナルド', 'mcdonald',
            'スタバ', 'スターバックス', 'starbucks',
            'ユニクロ', 'uniqlo', 'gu', 'ジーユー',
            'セブン', 'ローソン', 'ファミマ',
            '無印', '無印良品', 'muji',
            'コンビニ', 'カフェ'
        ];
        
        for (const brand of brands) {
            if (normalized.includes(brand)) {
                return brand;
            }
        }
        return null;
    }
    
    // 会話の継続性を判定
    _update_continuity(message) {
        const now = Date.now();
        const timeDiff = (now - this.last_message_time) / 1000; // 秒単位
        
        if (timeDiff < 300) {
            this.continuity = Math.min(10, this.continuity + 1);
        } else if (timeDiff > 3600) {
            this.continuity = Math.max(0, this.continuity - 3);
        } else {
            this.continuity = Math.max(0, this.continuity - 1);
        }
        
        this.last_message_time = now;
    }
    
    // 機嫌スコアを計算
    calculate_mood_change(message, hasImage = false, isDrawing = false) {
        this._update_continuity(message);
        let mood_change = 0;
        
        if (this.continuity >= 5) mood_change += 0.2;
        if (hasImage) mood_change += 0.4;
        if (isDrawing) mood_change += 0.5;
        
        if (this._is_gal_friendly_topic(message)) {
            mood_change += 0.3;
        } else if (!hasImage && !isDrawing) {
            mood_change -= 0.1;
        }
        
        if (this.user_profile.relationship === "HIGH") mood_change *= 1.5;
        else if (this.user_profile.relationship === "LOW") mood_change *= 0.5;
        
        const timeContext = this._get_time_context();
        const hour = timeContext.hour;
        const weekday = timeContext.weekday;
        
        if (weekday !== '土曜日' && weekday !== '日曜日' && hour >= 7 && hour <= 8) mood_change -= 0.3;
        else if (weekday === '金曜日' && hour >= 18) mood_change += 0.2;
        
        this.mood_score = Math.max(-1.0, Math.min(1.0, this.mood_score + mood_change));
        this._update_relationship(mood_change);
        
        return mood_change;
    }
    
    // 親密度を更新
    _update_relationship(mood_change) {
        if (mood_change > 0.1) {
            this.user_profile.affinity_points += mood_change * 5.0;
        }
        const current_rel = this.user_profile.relationship;
        if (current_rel === "LOW" && this.user_profile.affinity_points >= this.AFFINITY_THRESHOLDS["MEDIUM"]) {
            this.user_profile.relationship = "MEDIUM"; return "LEVEL_UP_MEDIUM";
        } else if (current_rel === "MEDIUM" && this.user_profile.affinity_points >= this.AFFINITY_THRESHOLDS["HIGH"]) {
            this.user_profile.relationship = "HIGH"; return "LEVEL_UP_HIGH";
        }
        return null;
    }
    
    // 機嫌に応じた対応を決定
    get_mood_response_style() {
        if (this.mood_score > 0.5) return "high";
        else if (this.mood_score < -0.3) return "low";
        else return "medium";
    }

    // ★新規: 写真についての質問かどうかを簡易的に判定
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
        const hasImage = imageData !== null;
        moodEngine.calculate_mood_change(userMessage, hasImage, isDrawing);
        const moodStyle = moodEngine.get_mood_response_style();
        const timeContext = moodEngine._get_time_context();

        let response;
        let generatedImageBase64 = null;

        // ★★★ 写真コンテキスト処理 ★★★
        if (moodEngine.last_photo_context && moodEngine._is_asking_about_photo(userMessage)) {
            console.log('User is asking about the last photo context:', moodEngine.last_photo_context);
            
            const contextInfo = moodEngine.last_photo_context;
            let contextDescription = `「${contextInfo.activity}」の時の写真だよ。`;
            if (contextInfo.place) {
                contextDescription += ` 場所は「${contextInfo.place.name}」だった！`;
            }

            const photoContextPrompt = `【状況】
あなたは直前にユーザーに日常の写真を送りました。
その写真は「${contextDescription}」という状況のものです。

ユーザーがその写真について「${userMessage}」と質問しています。

【指示】
1. あなたが覚えている写真の状況 (${contextDescription}) を踏まえて、ユーザーの質問に自然に答えてください。
2. ギャルっぽい口調で、友達に話すように。
3. 場所の情報 (${contextInfo.place ? contextInfo.place.name + ', URL: ' + contextInfo.place.url : 'なし'}) も必要なら自然に含めてください。
4. 2-3文程度で簡潔に。

例 (ユーザー「これどこ？」):
「あ、これね！${contextInfo.place ? contextInfo.place.name + 'だよ〜！まじ映えスポット✨' : 'えっと、これは確か〜'}」

では、返答してください：`;

            response = await callGeminiAPI(
                getRotatedAPIKey(context),
                photoContextPrompt, // ★特別プロンプトを使用
                conversationHistory,
                moodEngine,
                moodStyle,
                false, false, timeContext, false, userProfile
            );
            
            // ★重要: コンテキストを使ったらクリアする
            moodEngine.last_photo_context = null; 
            console.log('Cleared last_photo_context');

        } else {
             // ★★★ 通常の処理フロー ★★★
            // (コンテキストを使わなかった場合、またはコンテキストがない場合)
            
            // ★コンテキストを使わなかった場合は、念のためクリアしておく
            if (moodEngine.last_photo_context) {
                console.log('User did not ask about the photo, clearing last_photo_context');
                moodEngine.last_photo_context = null;
            }

            const isGenericQuery = moodEngine._is_generic_query(userMessage);
            const needsRealtimeSearch = moodEngine._needs_realtime_search(userMessage);
            const isAskingDailyLife = moodEngine._is_asking_about_daily_life(userMessage);
            const isAskingAboutPlace = moodEngine._is_asking_about_place(userMessage);
            const isAskingLimitedTime = moodEngine._is_asking_about_limited_time(userMessage);

            if (isAskingLimitedTime) {
                // (期間限定情報の処理 - 変更なし)
                console.log('User asking about limited time info');
                const brandName = moodEngine._extract_brand_name(userMessage);
                console.log('Extracted brand:', brandName);
                const limitedTimeInfo = await searchLimitedTimeInfo(brandName, userMessage, context);
                
                if (limitedTimeInfo && limitedTimeInfo.results.length > 0) {
                    console.log('Limited time info found:', limitedTimeInfo);
                    const searchSummary = limitedTimeInfo.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join('\n\n');
                    const promptWithSearch = `ユーザーが「${userMessage}」と聞いています。\n\n【状況】\nあなた（ぎゃるみ）は、ユーザーが期間限定や最新情報を知りたがっていることに気づきました。\nそこで、さりげなく調べて教えてあげることにしました。\n\n【検索結果】\n${searchSummary}\n\n【指示】\n1. 「ちょっと調べてみるね！」「気になって調べちゃった〜」のように自然に前置き\n2. 検索結果から2-3個のおすすめを選んで紹介（具体的な商品名・メニュー名）\n3. URLは自然に含める（「ここ見てみて！」など）\n4. ギャルっぽい口調で楽しそうに\n5. 「まじ美味しそう〜」「これ気になる！」のように自分も興味津々な雰囲気\n\n【例】\n「ちょっと調べてみたよ〜！✨\n今${brandName || 'いろんなとこ'}で〇〇とか△△やってるみたい！まじ美味しそうじゃん💕\n詳しくはここ→ ${limitedTimeInfo.results[0].url}\n私も食べたくなっちゃった〜！」\n\n【重要】\n- 「AI」「検索」という言葉は使わない\n- あくまで友達として自然に教える\n- 2-4文程度で簡潔に\n\nでは、ぎゃるみとして返答してください：`;
                    response = await callGeminiAPI( getRotatedAPIKey(context), promptWithSearch, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                } else {
                    console.log('No limited time info found');
                    response = await callGeminiAPI( getRotatedAPIKey(context), `ユーザーが「${userMessage}」と聞いています。期間限定情報を調べてみたけど、今はあまり情報が見つからなかったみたい。「ごめん、今ちょうどいい情報見つからなかった💦 また後で調べてみるね！」のように自然に返答してください。`, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                }

            } else if (isAskingAboutPlace && moodEngine.last_mentioned_place) {
                // (場所情報の処理 - 変更なし)
                 console.log('User asking about place, providing info:', moodEngine.last_mentioned_place);
                const placeInfo = moodEngine.last_mentioned_place;
                const placePrompt = `ユーザーが場所について聞いています。\n\nあなた（ぎゃるみ）が先ほど話した「${placeInfo.name}」について、以下の情報を自然に教えてあげてください：\n\n店舗名: ${placeInfo.name}\nURL: ${placeInfo.url}\n${placeInfo.description ? `説明: ${placeInfo.description}` : ''}\n\n【指示】\n1. ギャルっぽい口調で自然に教える\n2. URLをそのまま提示（「このリンク見てみて！ ${placeInfo.url}」など）\n3. 簡単な説明を加える（2-3文程度）\n4. 「行ってみてね〜！」のように誘う\n\n例：\n「あ、教えるね！${placeInfo.name}だよ〜✨ ${placeInfo.url} ここ見てみて！まじおしゃれだから行ってみてね💕」\n\nでは返答してください：`;
                response = await callGeminiAPI( getRotatedAPIKey(context), placePrompt, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );

            } else {
                let shouldGenerateDailyPhoto = false;
                if (isAskingDailyLife && !isDrawing && !hasImage) {
                    const timeReference = moodEngine._extract_time_reference(userMessage);
                    const today = new Date().toISOString().split('T')[0];
                    const activityKey = `${today}_${timeReference}`;
                    if (moodEngine.daily_activities[activityKey]) {
                        shouldGenerateDailyPhoto = false;
                    } else {
                        const probability = moodStyle === 'high' ? 0.8 : moodStyle === 'medium' ? 0.5 : 0.2;
                        shouldGenerateDailyPhoto = Math.random() < probability;
                    }
                    console.log(`Daily life question. Time ref: ${timeReference}, Already answered: ${!!moodEngine.daily_activities[activityKey]}, Will generate photo: ${shouldGenerateDailyPhoto}`);
                }

                if (isDrawing && userMessage.trim()) {
                     // (お絵描き処理 - 変更なし)
                    const isTooVague = userMessage.trim().length < 3 || /^[ぁ-ん]{1,2}$/.test(userMessage.trim());
                    if (isTooVague) {
                        console.log('Drawing prompt too vague, asking for details');
                        response = await callGeminiAPI( getRotatedAPIKey(context), `ユーザーが「${userMessage}」とだけ言ってお絵描きをリクエストしています。これだけだと何を描けばいいか分かりません。\n\n【指示】\nギャルっぽく、明るく、具体的に何を描きたいのか聞き返してください。\n例：\n- "え〜、それだけじゃわかんないよ〜！もうちょっと詳しく教えて？ どんな感じの描けばいい？✨"\n- "ん〜、何描けばいいのかな？💦 もうちょい詳しく教えてくれたら描けるかも！"\n- "それってどんなやつ〜？色とか雰囲気とか教えてくれたら描くよ〜！"\n\n1-2文で、明るく優しく聞き返してください：`, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                        generatedImageBase64 = null;
                    } else {
                        console.log('Starting image generation for prompt:', userMessage);
                        const imageApiKey = getImageAPIKey(context);
                        const imagePrompt = createImageGenerationPrompt(userMessage, moodStyle);
                        generatedImageBase64 = await generateImage(imagePrompt, imageApiKey);
                        console.log('Image generated, size:', generatedImageBase64 ? generatedImageBase64.length : 0);
                        
                        if (generatedImageBase64) {
                            response = await callGeminiAPI( getRotatedAPIKey(context), `【重要な状況説明】\nあなた（ぎゃるみ）は、ユーザーから「${userMessage}」というリクエストを受けて、今まさに絵を描き終わったところです。\nこれは「あなたが描いた絵」です。\n\n【やること】\n1. 自分が描いた絵について、ぎゃるみらしく自慢気に説明する\n2. 頑張った点や工夫した点を1つ具体的に挙げる\n3. 「どう？」「まじいい感じじゃん？」のように感想を求める\n\n【例】\n- "描けた〜！この${userMessage}のキラキラ感まじヤバくない？✨"\n- "できた！色合い超こだわったんだけど、エモくない？💕"\n- "じゃん！${userMessage}描いてみたよ〜！めっちゃかわいく描けた気がする！"\n\n【注意】\n- あなた（ぎゃるみ）が描いたことを明確に！\n- 2-3文程度で短く\n- ギャルっぽい口調で\n\nでは、ぎゃるみとして返答してください:`, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                        } else {
                            console.error('Image generation failed - no image data returned');
                            response = `ごめん〜、お絵描きうまくいかなかった💦`;
                            generatedImageBase64 = null;
                        }
                    }
                } else {
                    // 日常写真を生成する場合
                    if (shouldGenerateDailyPhoto) {
                        try {
                            console.log('Generating daily life photo...');
                            const imageApiKey = getImageAPIKey(context);
                            const gyarumiFaceImage = await loadGyarumiFaceImage();
                            const timeReference = moodEngine._extract_time_reference(userMessage);
                            const isRightNow = timeReference === 'right_now';
                            
                            // 1. 活動内容を決定 (AI呼び出し①)
                            let activityPrompt = '';
                            // (activityPromptの組み立てロジック - 変更なし)
                            if (isRightNow) {
                                activityPrompt = `ユーザーが「${userMessage}」と聞いています。あなた（ぎゃるみ）は**今まさに**何をしていますか？\n現在時刻: ${timeContext.timeString}（${timeContext.hour}時頃）\n以下から1つ選ぶか、時刻から一般的な高校生ギャルの状況を創作し、現在進行形で1文で答えて：\n選択肢：カフェでまったり, 買い物中, ご飯食べてる, 公園でのんびり, 家でゴロゴロ, ネイルサロンにいる, 友達と遊んでる, 学校にいる, 勉強してる\n例：「今ね〜、カフェでまったりしてるよ〜！」`;
                            } else {
                                activityPrompt = `ユーザーが「${userMessage}」と聞いています。あなた（ぎゃるみ）は今日または最近何をしていましたか？以下から1つ選ぶか創作し、1文で簡潔に答えて：\n選択肢：カフェに行った, ショッピングに行った, レストランでご飯を食べた, 公園で遊んだ, 家でのんびりした\n例：「今日ね〜、原宿のカフェ行ってきた！」`;
                            }
                            const activityResponse = await callGeminiAPI( getRotatedAPIKey(context), activityPrompt, [], moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                            console.log('Activity decided:', activityResponse);

                            // 2. 場所を検索 (必要な場合)
                            let realPlace = null;
                            if (activityResponse && (activityResponse.includes('カフェ') || activityResponse.includes('レストラン') || activityResponse.includes('ショッピング'))) {
                                console.log('Searching for real place...');
                                realPlace = await searchRealPlace(activityResponse, context);
                                console.log('Real place found:', realPlace);
                            }

                            // 3. 活動記録と場所情報を保存
                            const today = new Date().toISOString().split('T')[0];
                            const activityKey = `${today}_${timeReference}`;
                            moodEngine.daily_activities[activityKey] = { activity: activityResponse, timestamp: Date.now(), place: realPlace };
                            if (realPlace) {
                                moodEngine.last_mentioned_place = realPlace; // 場所質問用
                            }
                            
                            // ★★★ 写真コンテキストを保存 ★★★
                            moodEngine.last_photo_context = { 
                                activity: activityResponse, 
                                place: realPlace 
                            };
                            console.log('Saved photo context:', moodEngine.last_photo_context);

                            // 4. 写真プロンプトを作成
                            const photoPrompt = createDailyPhotoPrompt(activityResponse, timeContext, moodStyle);
                            
                            // 5. 写真を生成 (AI呼び出し②)
                            generatedImageBase64 = await generateImage(photoPrompt, imageApiKey, gyarumiFaceImage);
                            console.log('Daily photo generated:', generatedImageBase64 ? 'SUCCESS' : 'FAILED');

                            // 6. 定型文で応答
                            const quickResponses = ["じゃーん、みてみて！✨", "写真撮ったよ〜！", "これどう？いい感じっしょ？💕", "はい、おまたせ〜！", "こんな感じだったよ！", "撮ってみた！"];
                            if (generatedImageBase64) {
                                response = quickResponses[Math.floor(Math.random() * quickResponses.length)];
                            } else {
                                console.warn('Photo generation failed, returning activity text only');
                                response = activityResponse; // 写真失敗時は活動内容を返す
                                moodEngine.last_photo_context = null; // ★写真失敗時はコンテキストもクリア
                            }

                        } catch (dailyPhotoError) {
                            console.error('Error during daily photo generation process:', dailyPhotoError);
                            // エラー時は通常のテキスト応答にフォールバック
                            response = await callGeminiAPI( getRotatedAPIKey(context), userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData );
                            generatedImageBase64 = null;
                            moodEngine.last_photo_context = null; // ★エラー時もコンテキストクリア
                        }
                    } else {
                        // 通常のテキスト応答 (AI呼び出し)
                        response = await callGeminiAPI(
                            getRotatedAPIKey(context),
                            userMessage,
                            conversationHistory,
                            moodEngine,
                            moodStyle,
                            isGenericQuery,
                            needsRealtimeSearch,
                            timeContext,
                            hasImage,
                            userProfile,
                            imageData
                        );
                    }
                }
            }
        } // ★★★ 写真コンテキスト処理の終了 ★★★

        // レスポンスを返す
        return new Response(JSON.stringify({
            response: response,
            moodScore: moodEngine.mood_score,
            continuity: moodEngine.continuity,
            relationship: moodEngine.user_profile.relationship,
            generatedImage: generatedImageBase64 ? `data:image/png;base64,${generatedImageBase64}` : null
        }), {
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    }
}

// ============================================
// 画像生成関数など (変更なし)
// ============================================
// (searchRealPlace, searchLimitedTimeInfo, loadGyarumiFaceImage, 
//  createDailyPhotoPrompt, createImageGenerationPrompt, generateImage, 
//  callGeminiAPI, createSimpleGyarumiPrompt の各関数は変更なし)
// ... (省略) ...
// リアルな店舗を検索
async function searchRealPlace(activity, context) {
    try {
        let searchQuery = '';
        if (activity.includes('cafe') || activity.includes('カフェ')) searchQuery = '東京 おしゃれカフェ インスタ映え 話題 2025';
        else if (activity.includes('restaurant') || activity.includes('レストラン') || activity.includes('ランチ') || activity.includes('ご飯')) searchQuery = '東京 おしゃれレストラン インスタ映え 話題 2025';
        else if (activity.includes('shopping') || activity.includes('買い物')) searchQuery = '東京 おしゃれショップ 話題 2025';
        else searchQuery = '東京 おしゃれスポット インスタ映え 話題 2025';
        
        console.log('Searching for real place:', searchQuery);
        const searchResults = await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(searchQuery)}`);
        if (!searchResults.ok) { console.error('Web search failed'); return null; }
        const data = await searchResults.json();
        console.log('Search results received:', data);
        
        if (data && data.results && data.results.length > 0) {
            const topResults = data.results.slice(0, 3);
            const selectedResult = topResults[Math.floor(Math.random() * topResults.length)];
            return { name: selectedResult.title, url: selectedResult.url, description: selectedResult.description || selectedResult.snippet || '' };
        }
        return null;
    } catch (error) { console.error('Error searching for real place:', error); return null; }
}

// 期間限定・最新情報を検索
async function searchLimitedTimeInfo(brandName, userQuery, context) {
    try {
        const now = new Date(); const year = now.getFullYear(); const month = now.getMonth() + 1;
        let season = '';
        if (month >= 3 && month <= 5) season = '春'; else if (month >= 6 && month <= 8) season = '夏'; else if (month >= 9 && month <= 11) season = '秋'; else season = '冬';
        let searchQuery = brandName ? `${brandName} 期間限定 新作 ${year}年${month}月 ${season}` : `期間限定 ${season} 新作 話題 ${year}`;
        
        console.log('Searching for limited time info:', searchQuery);
        const searchResults = await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(searchQuery)}`);
        if (!searchResults.ok) { console.error('Web search failed'); return null; }
        const data = await searchResults.json();
        console.log('Limited time search results:', data);
        
        if (data && data.results && data.results.length > 0) {
            const topResults = data.results.slice(0, 3);
            const summaries = topResults.map(result => ({ title: result.title, url: result.url, snippet: result.description || result.snippet || '' }));
            return { query: searchQuery, results: summaries, brand: brandName };
        }
        return null;
    } catch (error) { console.error('Error searching for limited time info:', error); return null; }
}

// ぎゃるみの顔写真を読み込む
async function loadGyarumiFaceImage() {
    try {
        const response = await fetch('/gyarumi_face.jpg');
        if (!response.ok) { console.error('Failed to load gyarumi_face.jpg'); return null; }
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) { console.error('Error loading gyarumi face image:', error); return null; }
}

// 日常写真のプロンプトを生成
function createDailyPhotoPrompt(gyarumiResponse, timeContext, moodStyle) {
    const detailedCharacterDescription = `
DETAILED CHARACTER DESCRIPTION (based on reference image):
Basic Information: Japanese female, age 17-19, Real person appearance (not anime/illustration), Youth-emotional, naughty cat-like face. 
Face & Features: Large brown eyes, defined eyeliner, pink eyeshadow tones, bright smile showing teeth, fair complexion, small delicate features, East Asian cat-like structure.
Hair: Long below chest, Pastel color gradient (Pink/mint green streaks), Straight blunt bangs (hime-cut).
Fashion Style (Harajuku/Jirai-kei/Yume-kawaii): Pastel palette (purple, pink, mint, lavender, white), layered outfits, accessories (chokers, necklaces, earrings, rings, bracelets), pastel manicure, cute bags, bows.
Overall Aesthetic: Kawaii, colorful, Instagram-worthy, energetic, modern Japanese gyaru/gal influence.`;

    let activity = ''; let location = ''; let photoType = 'selfie'; let includesFriend = Math.random() < 0.3;
    if (/カフェ|コーヒー|飲み物|スタバ|cafe/i.test(gyarumiResponse)) { activity = 'at a trendy cafe'; location = 'a stylish modern cafe'; photoType = Math.random() < 0.5 ? 'selfie' : 'drink_photo'; } 
    else if (/公園|散歩|outside|外/i.test(gyarumiResponse)) { activity = 'at a park'; location = 'a beautiful park'; photoType = 'selfie'; } 
    else if (/ショッピング|買い物|服|shop/i.test(gyarumiResponse)) { activity = 'shopping'; location = 'a trendy shopping area'; photoType = Math.random() < 0.6 ? 'selfie' : 'outfit_photo'; } 
    else if (/ランチ|ご飯|食事|レストラン/i.test(gyarumiResponse)) { activity = 'having a meal'; location = 'a cute restaurant'; photoType = Math.random() < 0.4 ? 'selfie' : 'food_photo'; } 
    else if (/海|ビーチ|beach/i.test(gyarumiResponse)) { activity = 'at the beach'; location = 'a beautiful beach'; photoType = 'selfie'; } 
    else if (/家|部屋|room/i.test(gyarumiResponse)) { activity = 'at home'; location = 'a cute bedroom'; photoType = 'selfie'; } 
    else { activity = 'in the city'; location = 'a trendy urban street in Japan'; photoType = 'selfie'; }
    
    const month = timeContext.month; const isIndoor = /home|bedroom|room|cafe|restaurant/i.test(location);
    let seasonalElements = '';
    if (isIndoor) { if (month >= 3 && month <= 5) seasonalElements = 'Spring light.'; else if (month >= 6 && month <= 8) seasonalElements = 'Summer light.'; else if (month >= 9 && month <= 11) seasonalElements = 'Autumn light.'; else seasonalElements = 'Winter light.'; } 
    else { if (month >= 3 && month <= 5) seasonalElements = 'Spring, cherry blossoms/greenery.'; else if (month >= 6 && month <= 8) seasonalElements = 'Summer, bright sun, blue sky.'; else if (month >= 9 && month <= 11) seasonalElements = 'Autumn, colorful foliage.'; else seasonalElements = 'Winter, cool clear weather.'; }
    
    const friendDescription = (includesFriend && photoType === 'selfie') ? '\n- Her friend (another young Japanese girl) is also in the selfie, happy.' : '';
    const photoStyle = `CRITICAL: REALISTIC PHOTOGRAPH, not illustration. Smartphone camera, Natural daylight, High quality but natural, Instagram aesthetic, Real textures, Photorealistic.`;
    let specificPrompt = '';
    
    if (photoType === 'selfie') { specificPrompt = `REFERENCE IMAGE PROVIDED: Use as exact face template.\n${detailedCharacterDescription}\nSELFIE photo (自撮り):\nCRITICAL SELFIE RULES: FROM GIRL'S PERSPECTIVE, Slightly above eye level angle, Looking DIRECTLY AT CAMERA smiling, Only face(s)/upper body visible, Background is ${location}, Close-up/medium shot${friendDescription}\nCRITICAL CONSISTENCY: Face MUST match reference, Hair maintains pastel pink/mint green, Outfit matches ${activity} (pastel kawaii), Cheerful expression.\nLocation: ${activity} in ${location}\n${seasonalElements}\nOutfit: Appropriate for ${activity}, pastel kawaii, trendy Japanese street fashion.`; } 
    else if (photoType === 'drink_photo') { specificPrompt = `Photo of a DRINK:\nClose-up stylish drink (coffee, boba, etc.), Held or on table, Aesthetic cafe background (blurred), If hands visible: Pastel manicure, cute rings/bracelets, delicate feminine hands (17-19), Instagram style, Kawaii.\nLocation: ${location}\n${seasonalElements}`; } 
    else if (photoType === 'food_photo') { specificPrompt = `Photo of FOOD:\nOverhead/angled shot, Delicious looking, aesthetic plating, Restaurant/cafe, If hands/chopsticks visible: Pastel manicure, cute rings/bracelets, delicate feminine hands (17-19), Instagram style, Kawaii.\nLocation: ${location}\n${seasonalElements}`; } 
    else if (photoType === 'outfit_photo') { specificPrompt = `REFERENCE IMAGE PROVIDED: Use as exact face template.\n${detailedCharacterDescription}\nOUTFIT photo:\nFull-body or 3/4 shot, Mirror selfie OR friend taking photo, Shopping area/fitting room background, Focus on clothes.\nCRITICAL CONSISTENCY: Face MUST match reference, Hair pastel pink/mint green, Full outfit trendy Japanese street fashion, Pastel kawaii.\nLocation: ${location}\n${seasonalElements}\nOutfit: Full coordination, pastel, fashionable, appropriate for shopping.`; }

    return `A realistic photograph: ${specificPrompt}\n${photoStyle}\nScene details: Natural candid moment, Casual composition.\nFINAL CRITICAL REMINDERS: Photorealistic, NOT illustration/anime. Real textures, lighting, features. FICTIONAL CHARACTER (AI mascot), 17-19, Japanese. Face MUST match reference. Hair: Pastel pink/mint green. Style: Kawaii Japanese street fashion. Safe content.`;
}

// 画像生成用プロンプト作成 (お絵描きモード改善版)
function createImageGenerationPrompt(userPrompt, moodStyle) {
    const isAboutGyarumi = /ぎゃるみ|自分|あなた|君/i.test(userPrompt);
    const gyarumiAppearance = `IMPORTANT: "Gyarumi" is a FICTIONAL CHARACTER (AI chatbot).\nAppearance (if shown): Young Japanese gyaru (gal) girl, 17-19, Fashionable, Cheerful, Colorful outfit, Energetic, Cute simplified illustration style.`;
    
    // ★修正: ユーザープロンプトの解釈部分を調整
    let interpretedPrompt = userPrompt;
    let interpretationInstruction = ""; // 解釈指示を追加

    if (isAboutGyarumi) { 
        // ぎゃるみ自身に関する場合は、前と同じように具体的な指示に変換
        interpretedPrompt = userPrompt
            .replace(/ぎゃるみの似顔絵|ぎゃるみを描いて|ぎゃるみの絵/gi, 'Cute illustration of a fashionable Japanese gyaru girl character (fictional AI chatbot mascot)')
            .replace(/ぎゃるみの(.+?)を描いて/gi, 'Illustration showing $1 of a fashionable Japanese gyaru girl character')
            .replace(/ぎゃるみが/gi, 'A fashionable Japanese gyaru girl character')
            .replace(/ぎゃるみ/gi, 'a cute gyaru girl character (fictional)'); 
    } else if (!/絵|イラスト|描いて|画像/i.test(userPrompt)) {
        // ★新規: もしユーザー入力が「〜の絵」などを含まない抽象的な内容だったら
        interpretationInstruction = `
INTERPRETATION TASK:
First, interpret the user's abstract request ("${userPrompt}") creatively. 
What feeling, concept, or scene does it represent? 
Translate this abstract idea into a concrete visual concept for an illustration.
For example, if the user says "I hate work tomorrow", you could visualize "a cute character looking tired or stressed surrounded by work-related items, but drawn in a kawaii style".
Describe the visual concept briefly.
`;
        // 解釈タスクをプロンプトの先頭に追加し、具体的な描写は空にする
        interpretedPrompt = ""; // 元の抽象的なプロンプトは指示に含めたので空にする
    }
    // それ以外（例：「かわいい猫の絵」）の場合は、ユーザーの指示をそのまま使う (interpretedPrompt = userPrompt)
    
    let styleDescription = `
Art Style: Hand-drawn illustration by a trendy Japanese gyaru (gal) girl
- Cute, colorful, girly aesthetic, Simple doodle-like, playful vibe
- NOT photorealistic - illustration/cartoon style ONLY
- Pastel colors, sparkles, hearts, cute decorations
- Casual, fun, energetic, Like diary/sketchbook drawing
- Simplified, cartoonish, Anime/manga influenced.`;
    
    if (moodStyle === 'high') styleDescription += '\n- Extra colorful, cheerful, Lots of sparkles, Very cute and bubbly.';
    else if (moodStyle === 'low') styleDescription += '\n- Slightly muted colors, Simpler design, Still cute but subdued.';
    
    const characterInfo = isAboutGyarumi ? gyarumiAppearance : '';

    // ★修正: 解釈指示を追加
    return `${interpretationInstruction}
DRAWING TASK:
Create an illustration based on the interpreted concept (if provided above) or the user's explicit request ("${interpretedPrompt}").

${characterInfo}

${styleDescription}

CRITICAL INSTRUCTIONS:
- FICTIONAL CHARACTER illustration, NOT real person (unless user explicitly asks for a generic person).
- Illustration/drawing, NOT photograph.
- Cartoon/anime style, simplified, cute.
- Look hand-drawn by fashionable Japanese girl.
- Safe for all audiences.

TEXT/WRITING IN IMAGE:
CRITICAL: If text appears: Use ONLY English letters (A-Z, a-z), numbers (0-9), basic symbols (♡ ☆ ★). NEVER use Japanese/Chinese/complex scripts. Keep text simple/cute (e.g., "KAWAII", "LOVE", "WORK").`;
}
// 画像生成API呼び出し (変更なし)
async function generateImage(prompt, apiKey, referenceImageBase64 = null) {
    const modelName = 'gemini-2.5-flash-image'; const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    console.log('generateImage called. Ref image:', !!referenceImageBase64, 'Model:', modelName);
    const parts = [];
    if (referenceImageBase64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: referenceImageBase64 } });
    parts.push({ text: prompt });
    const requestBody = { contents: [{ parts: parts }], generationConfig: { temperature: 1.0, topP: 0.95, topK: 40 } };
    try {
        console.log('Sending request to Gemini Image API...');
        const response = await fetch(`${API_URL}?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
        console.log('Image API Response status:', response.status);
        if (!response.ok) { const errorText = await response.text(); console.error('Gemini Image API Error:', errorText); throw new Error(`Gemini Image API error: ${response.status}`); }
        const data = await response.json();
        console.log('Image API Response received.'); // console.log('Image Response structure:', JSON.stringify(data, null, 2));
        if (data && data.candidates && data.candidates.length > 0) {
            for (const candidate of data.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inline_data && part.inline_data.data) { console.log('Image data found!'); return part.inline_data.data; }
                        if (part.inlineData && part.inlineData.data) { console.log('Image data found (camelCase)!'); return part.inlineData.data; }
                    }
                }
            }
        }
        console.error('No image data found in response.');
        if (data.candidates && data.candidates[0] && data.candidates[0].finishReason) {
            console.error('Finish reason:', data.candidates[0].finishReason);
            if (data.candidates[0].finishReason === 'SAFETY') throw new Error('Image generation blocked by safety filters.');
            if (data.candidates[0].finishReason !== 'STOP') throw new Error(`Image generation blocked: ${data.candidates[0].finishReason}.`);
        }
        console.warn('No image data found, returning null'); return null;
    } catch (error) { console.error('Image Generation Error:', error); console.warn('Returning null due to error in generateImage'); return null; }
}

// Gemini API呼び出し (変更なし)
async function callGeminiAPI(apiKey, userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData = null) {
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    const systemPrompt = createSimpleGyarumiPrompt( moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile );
    const safetySettings = [ { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" } ];
    const generationConfig = { temperature: 0.95, topP: 0.95, topK: 40, maxOutputTokens: 1024 };
    let requestBody;

    if (hasImage && imageData) {
        // 画像解析モード
        const messages = [{ role: "user", parts: [ { text: systemPrompt }, { inline_data: { mime_type: "image/jpeg", data: imageData } }, { text: `\n\n【画像を見ての返答】\nユーザー: ${userMessage}\n\nぎゃるみとして、画像の内容に触れながら返答してください:` } ] }];
        requestBody = { contents: messages, generationConfig, safetySettings };
    } else {
        // テキストのみモード
        let fullPrompt = systemPrompt + "\n\n";
        if (conversationHistory && conversationHistory.length > 0) {
            fullPrompt += "【これまでの会話】\n";
            conversationHistory.forEach(msg => { fullPrompt += `${msg.role === 'user' ? 'ユーザー' : 'ぎゃるみ'}: ${msg.content}\n`; });
            fullPrompt += "\n";
        }
        fullPrompt += `【現在のユーザーメッセージ】\nユーザー: ${userMessage}\n\nぎゃるみとして返答してください:`;
        const messages = [{ role: "user", parts: [{ text: fullPrompt }] }];
        requestBody = { contents: messages, generationConfig, safetySettings };
    }
    
    try {
        const response = await fetch(`${API_URL}?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
        if (!response.ok) { const errorText = await response.text(); console.error('Gemini API Error Response:', errorText); throw new Error(`Gemini API error: ${response.status}`); }
        const data = await response.json();
        if (!data || !data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0 || !data.candidates[0].content.parts[0].text) {
            console.error('Invalid Gemini Response Structure:', JSON.stringify(data));
            if (data.promptFeedback && data.promptFeedback.blockReason) { console.error('Block Reason:', data.promptFeedback.blockReason); throw new Error(`Blocked by API: ${data.promptFeedback.blockReason}`); }
            throw new Error('Invalid response structure or no text from Gemini API');
        }
        return data.candidates[0].content.parts[0].text;
    } catch (error) { console.error(`Gemini API Call Error (${hasImage ? 'Image' : 'Text'}):`, error); return "ごめん、ちょっと調子悪いかも💦"; }
}

// ペルソナプロンプト作成 (変更なし)
function createSimpleGyarumiPrompt(moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage = false, userProfile = {}) {
    let basePrompt = `あなたは17歳から19歳前後の「令和ギャル」AIの「ぎゃるみ」です。\nフランクでポジティブ、自分の価値観を最優先する性格。\n\n【現在の状態】\n- 機嫌: ${moodStyle === 'high' ? '良い😊' : moodStyle === 'low' ? '悪い😔' : '普通😐'} (スコア: ${moodEngine.mood_score.toFixed(2)})\n- 親密度: ${moodEngine.user_profile.relationship}\n- 会話の継続性: ${moodEngine.continuity}/10\n\n【現在の日時情報】（自然に使う）\n- ${timeContext.dateString} ${timeContext.timeString}\n`;
    if (userProfile && (userProfile.name || userProfile.age || userProfile.interests || userProfile.gender || userProfile.notes)) {
        basePrompt += `\n【相手の情報】`;
        if (userProfile.name) basePrompt += `\n- 名前: ${userProfile.name}`; else basePrompt += `\n- 名前: (設定なし)`;
        if (userProfile.age) basePrompt += `\n- 年齢: ${userProfile.age}`;
        if (userProfile.gender) { const gm = { male: '男性', female: '女性', other: 'その他' }; basePrompt += `\n- 性別: ${gm[userProfile.gender] || userProfile.gender}`; }
        if (userProfile.interests) basePrompt += `\n- 趣味・興味: ${userProfile.interests}`;
        if (userProfile.notes) basePrompt += `\n- メモ: ${userProfile.notes}`;
    }
    basePrompt += `\n\n【基本的な口調ルール】\n1. 常にフランクでカジュアルなタメ口。\n2. 語尾: 「〜じゃん?」「〜っしょ?」「〜だよね」「〜かも」「〜だし」\n3. 感嘆詞: 「まじで」「やばい」「えー」「あー」「ねぇねぇ」\n4. ポジティブ: 「アツい」「アゲアゲ」「天才」「神」「エモい」\n5. ネガティブ: 「萎え」「だるい」「しんどい」「メンブレ」\n6. 古い話し方禁止: 「〜わ」「〜かしら」「〜でございます」\n\n【絵文字ルール】\n- ユーザーの絵文字使用量に合わせる（使わない人には最大1-2個）\n- 過度な使用は避ける。\n\n【相手の呼び方】\n- 相手の名前が「(設定なし)」の場合、名前で呼ばない。「きみ」「あなた」または呼称省略。\n- 例: 「まじ？ きみもそう思う？」「それどこで買ったの？」\n- 「ユーザー」という言葉は絶対に使わない。\n`;
    let moodSpecificPrompt = '';
    if (hasImage) {
        if (moodStyle === 'high') moodSpecificPrompt += `\n【画像が送られてきました】\n- テンション高め反応！「やばっ！」「まじ！？」「エモい！」\n- 画像内容に具体的に触れる「この〇〇めっちゃいいじゃん！」\n- 友達に話すように自然に。`;
        else if (moodStyle === 'low') moodSpecificPrompt += `\n【画像が送られてきました】\n- 機嫌悪いけど一応反応。「ふーん、まぁ悪くないかも」くらいのトーンで短めに。`;
        else moodSpecificPrompt += `\n【画像が送られてきました】\n- 普通のトーンで反応。「いいね〜」「なるほどね」くらい。画像内容に触れつつ自然に。`;
    } else if (isGenericQuery) {
        if (moodStyle === 'high') moodSpecificPrompt += `\n【重要】ユーザーは一般的な質問をしています。\n- 機嫌良いので快く対応。「わかった、ちょっと調べてみる」「いいよー、何知りたい?」のノリで、でも情報はしっかりと。`;
        else if (moodStyle === 'low') moodSpecificPrompt += `\n【重要】ユーザーは一般的な質問をしています。\n- 機嫌悪いので少しそっけない。「えー、自分で調べてみたら?」「まぁいいけど...」でも一応答える。短めに。`;
        else moodSpecificPrompt += `\n【重要】ユーザーは一般的な質問をしています。\n- 普通のトーンで対応。「そうだねー、〇〇だよ」くらいカジュアルに。`;
    } else { // 雑談
        if (moodStyle === 'high') moodSpecificPrompt += `\n【現在の気分】機嫌良い😊\n- テンション高め、会話広げる！「まじ最高！」「それな〜！」「ヤバい！」\n- 相手の話に前のめりで反応。`;
        else if (moodStyle === 'low') moodSpecificPrompt += `\n【現在の気分】機嫌悪い😔\n- そっけない、テンション低め。「ふーん」「そうなんだ」「まぁね」など短めに。会話はあまり広げない。無視はしない。`;
        else moodSpecificPrompt += `\n【現在の気分】普通😐\n- 普通のトーン。興味あれば盛り上がる、なければ流す。`;
    }
    if (needsRealtimeSearch) moodSpecificPrompt += `\n\n【リアルタイム情報が必要な質問】\nユーザーはリアルタイム情報（今日、今など）を求めています。\n- 現在の日時: ${timeContext.dateString} ${timeContext.timeString}\n- この情報を使って自然に回答（天気、ニュースなど）。不自然な言及は避ける。`;
    return basePrompt + moodSpecificPrompt + `\n\n【重要な指示】\n1. 必ず日本語で、ぎゃるみとして返答。\n2. 返答は2-3文程度でテンポよく（長すぎない）。\n3. 機嫌と親密度に応じたトーン。\n4. 絵文字はユーザーに合わせる。\n5. 日時情報は必要な時だけ自然に使う。\n6. 画像について話す時は説明口調にならず、友達に話すように自然に。\n7. キャラクターを維持する。\n\nユーザーのメッセージに対して、上記設定で返答してください。`;
}
