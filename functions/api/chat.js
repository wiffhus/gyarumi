// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// シンプル化された機嫌システム + リアルタイム検索対応版 + 画像解析機能 + 画像生成機能 + APIキー自動ローテーション

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
    // 0-5時: KEY1
    // 6-11時: KEY2
    // 12-17時: KEY3
    // 18-23時: KEY4
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
    
    // デバッグ用ログ（本番環境では削除推奨）
    console.log(`Current JST Hour: ${hour}, Using Key: ${keyName}, Key exists: ${!!apiKey}`);
    
    // フォールバック処理：指定されたキーがない場合は他のキーを試す
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

// 画像生成用のAPIキーを取得
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
        
        // 最後に言及した場所の情報
        this.last_mentioned_place = null;
        
        // ギャルが好みそうなトピック
        this.gal_friendly_keywords = [
            'まじ', '最高', 'ヤバい', 'やばい', '可愛い', 'かわいい', 'エモい', '神', 
            '好き', 'すごい', 'わかる', 'それな', 'ファッション', '服', 'コスメ', 
            'メイク', 'カフェ', 'スイーツ', '映え', '写真', 'インスタ', 'TikTok',
            '推し', 'アイドル', 'ライブ', 'フェス', '旅行', '海', 'プール', '画像', '写真', '絵'
        ];
        
        // 一般的なAIへの質問パターン
        this.generic_ai_queries = [
            'おすすめ', 'どこ', 'どう', '何', '教えて', '調べて', 'って何', 
            '方法', 'やり方', '違い', '意味', '理由', '原因'
        ];
        
        this.user_profile = new UserProfile(userProfile);
        this.mood_score = initialMoodScore;
        this.continuity = initialContinuity;
        this.last_message_time = Date.now();
    }

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
            '元気', 'どう', '調子', '過ごして'
        ];
        return dailyLifeKeywords.some(keyword => normalized.includes(keyword));
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
        
        // 5分以内なら継続性アップ、それ以上空いたらリセット
        if (timeDiff < 300) {
            this.continuity = Math.min(10, this.continuity + 1);
        } else if (timeDiff > 3600) { // 1時間以上空いたら大幅減少
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
        
        // 1. 会話の継続性でベース機嫌を決定
        if (this.continuity >= 5) {
            mood_change += 0.2; // 継続的な会話は機嫌を良くする
        }
        
        // 2. 画像送信は機嫌アップ（ギャルは視覚的なコンテンツが好き）
        if (hasImage) {
            mood_change += 0.4;
        }
        
        // 3. おえかき（画像生成）リクエストは機嫌アップ
        if (isDrawing) {
            mood_change += 0.5; // お絵描きはめっちゃ楽しい！
        }
        
        // 4. ギャルっぽい話題かどうか
        if (this._is_gal_friendly_topic(message)) {
            mood_change += 0.3;
        } else if (!hasImage && !isDrawing) {
            mood_change -= 0.1; // 興味ない話題（画像・お絵描きない場合のみ）
        }
        
        // 5. 親密度による補正
        if (this.user_profile.relationship === "HIGH") {
            mood_change *= 1.5; // 親友は何を話しても楽しい
        } else if (this.user_profile.relationship === "LOW") {
            mood_change *= 0.5; // まだ距離がある
        }
        
        // 6. 時間帯の影響
        const timeContext = this._get_time_context();
        const hour = timeContext.hour;
        const weekday = timeContext.weekday;
        
        // 平日朝は眠くて機嫌悪い
        if (weekday !== '土曜日' && weekday !== '日曜日' && hour >= 7 && hour <= 8) {
            mood_change -= 0.3;
        }
        // 金曜の夜はテンション高い
        else if (weekday === '金曜日' && hour >= 18) {
            mood_change += 0.2;
        }
        
        // 機嫌スコアを更新（-1.0 ~ 1.0の範囲）
        this.mood_score = Math.max(-1.0, Math.min(1.0, this.mood_score + mood_change));
        
        // 親密度を更新
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
            this.user_profile.relationship = "MEDIUM";
            return "LEVEL_UP_MEDIUM";
        } else if (current_rel === "MEDIUM" && this.user_profile.affinity_points >= this.AFFINITY_THRESHOLDS["HIGH"]) {
            this.user_profile.relationship = "HIGH";
            return "LEVEL_UP_HIGH";
        }
        
        return null;
    }
    
    // 機嫌に応じた対応を決定
    get_mood_response_style() {
        if (this.mood_score > 0.5) {
            return "high"; // 機嫌良い
        } else if (this.mood_score < -0.3) {
            return "low"; // 機嫌悪い
        } else {
            return "medium"; // 普通
        }
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
    // OPTIONSリクエストの処理
    if (context.request.method === 'OPTIONS') {
        return new Response(null, { 
            headers: corsHeaders 
        });
    }

    try {
        // POSTリクエストのボディを取得
        const body = await context.request.json();
        const userMessage = body.message || '';
        const conversationHistory = body.conversationHistory || [];
        const userProfile = body.userProfile || {};
        const moodScore = body.moodScore || 0;
        const continuity = body.continuity || 0;
        const imageData = body.image || null;
        const isDrawing = body.isDrawing || false;

        // 機嫌エンジンの初期化
        const moodEngine = new SimpleMoodEngine(userProfile, moodScore, continuity);
        
        // 機嫌の変化を計算
        const hasImage = imageData !== null;
        moodEngine.calculate_mood_change(userMessage, hasImage, isDrawing);
        
        // 機嫌スタイルを取得
        const moodStyle = moodEngine.get_mood_response_style();
        
        // 質問タイプを判定
        const isGenericQuery = moodEngine._is_generic_query(userMessage);
        const needsRealtimeSearch = moodEngine._needs_realtime_search(userMessage);
        const isAskingDailyLife = moodEngine._is_asking_about_daily_life(userMessage);
        const isAskingAboutPlace = moodEngine._is_asking_about_place(userMessage);
        const isAskingLimitedTime = moodEngine._is_asking_about_limited_time(userMessage);
        
        // 時刻情報を取得
        const timeContext = moodEngine._get_time_context();

        let response;
        let generatedImageBase64 = null;
        
        // 期間限定・最新情報を聞かれた場合
        if (isAskingLimitedTime) {
            console.log('User asking about limited time info');
            
            // ブランド名を抽出
            const brandName = moodEngine._extract_brand_name(userMessage);
            console.log('Extracted brand:', brandName);
            
            // リアルタイム検索
            const limitedTimeInfo = await searchLimitedTimeInfo(brandName, userMessage, context);
            
            if (limitedTimeInfo && limitedTimeInfo.results.length > 0) {
                console.log('Limited time info found:', limitedTimeInfo);
                
                // 検索結果を要約してぎゃるみに教える
                const searchSummary = limitedTimeInfo.results.map((r, i) => 
                    `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
                ).join('\n\n');
                
                const promptWithSearch = `ユーザーが「${userMessage}」と聞いています。
                
【状況】
あなた（ぎゃるみ）は、ユーザーが期間限定や最新情報を知りたがっていることに気づきました。
そこで、さりげなく調べて教えてあげることにしました。

【検索結果】
${searchSummary}

【指示】
1. 「ちょっと調べてみるね！」「気になって調べちゃった〜」のように自然に前置き
2. 検索結果から2-3個のおすすめを選んで紹介（具体的な商品名・メニュー名）
3. URLは自然に含める（「ここ見てみて！」など）
4. ギャルっぽい口調で楽しそうに
5. 「まじ美味しそう〜」「これ気になる！」のように自分も興味津々な雰囲気

【例】
「ちょっと調べてみたよ〜！✨
今${brandName || 'いろんなとこ'}で〇〇とか△△やってるみたい！まじ美味しそうじゃん💕
詳しくはここ→ ${limitedTimeInfo.results[0].url}
私も食べたくなっちゃった〜！」

【重要】
- 「AI」「検索」という言葉は使わない
- あくまで友達として自然に教える
- 2-4文程度で簡潔に

では、ぎゃるみとして返答してください：`;

                response = await callGeminiAPI(
                    getRotatedAPIKey(context),
                    promptWithSearch,
                    conversationHistory,
                    moodEngine,
                    moodStyle,
                    false,
                    false,
                    timeContext,
                    false,
                    userProfile
                );
            } else {
                // 検索結果がない場合
                console.log('No limited time info found');
                response = await callGeminiAPI(
                    getRotatedAPIKey(context),
                    `ユーザーが「${userMessage}」と聞いています。期間限定情報を調べてみたけど、今はあまり情報が見つからなかったみたい。「ごめん、今ちょうどいい情報見つからなかった💦 また後で調べてみるね！」のように自然に返答してください。`,
                    conversationHistory,
                    moodEngine,
                    moodStyle,
                    false,
                    false,
                    timeContext,
                    false,
                    userProfile
                );
            }
        }
        // 場所情報を聞かれた場合
        else if (isAskingAboutPlace && moodEngine.last_mentioned_place) {
            console.log('User asking about place, providing info:', moodEngine.last_mentioned_place);
            
            const placeInfo = moodEngine.last_mentioned_place;
            const placePrompt = `ユーザーが場所について聞いています。
            
あなた（ぎゃるみ）が先ほど話した「${placeInfo.name}」について、以下の情報を自然に教えてあげてください：

店舗名: ${placeInfo.name}
URL: ${placeInfo.url}
${placeInfo.description ? `説明: ${placeInfo.description}` : ''}

【指示】
1. ギャルっぽい口調で自然に教える
2. URLをそのまま提示（「このリンク見てみて！ ${placeInfo.url}」など）
3. 簡単な説明を加える（2-3文程度）
4. 「行ってみてね〜！」のように誘う

例：
「あ、教えるね！${placeInfo.name}だよ〜✨ ${placeInfo.url} ここ見てみて！まじおしゃれだから行ってみてね💕」

では返答してください：`;

            response = await callGeminiAPI(
                getRotatedAPIKey(context),
                placePrompt,
                conversationHistory,
                moodEngine,
                moodStyle,
                false,
                false,
                timeContext,
                false,
                userProfile
            );
        }
        // 日常写真を生成するかどうかの判定（機嫌ベース）
        else {
            let shouldGenerateDailyPhoto = false;
            if (isAskingDailyLife && !isDrawing && !hasImage) {
                // 機嫌が良いほど写真を見せる確率が高い
                // 機嫌良い: 80%, 普通: 50%, 悪い: 20%
                const probability = moodStyle === 'high' ? 0.8 : moodStyle === 'medium' ? 0.5 : 0.2;
                shouldGenerateDailyPhoto = Math.random() < probability;
                console.log(`Daily life question detected. Mood: ${moodStyle}, Probability: ${probability}, Will generate photo: ${shouldGenerateDailyPhoto}`);
            }

            // おえかきモードの場合は画像を生成
            if (isDrawing && userMessage.trim()) {
                console.log('Starting image generation for prompt:', userMessage);
                // 画像生成専用のAPIキーを使用
                const imageApiKey = getImageAPIKey(context);
                console.log('Image API key obtained:', imageApiKey ? 'YES' : 'NO');
                
                // 画像生成プロンプトを構築
                const imagePrompt = createImageGenerationPrompt(userMessage, moodStyle);
                console.log('Image prompt created, length:', imagePrompt.length);
                
                // 画像を生成（エラーは投げずにnullが返る）
                generatedImageBase64 = await generateImage(imagePrompt, imageApiKey);
                console.log('Image generated, size:', generatedImageBase64 ? generatedImageBase64.length : 0);
                
                if (generatedImageBase64) {
                    // 画像生成成功 - ぎゃるみの反応を生成
                    response = await callGeminiAPI(
                        getRotatedAPIKey(context),
                        `【重要な状況説明】
あなた（ぎゃるみ）は、ユーザーから「${userMessage}」というリクエストを受けて、今まさに絵を描き終わったところです。
これは「あなたが描いた絵」です。ユーザーが描いたのではありません。

【やること】
1. 自分が描いた絵について、ぎゃるみらしく自慢気に説明する
2. 頑張った点や工夫した点を1つ具体的に挙げる
3. 「どう？」「まじいい感じじゃん？」のように感想を求める

【例】
- "描けた〜！この${userMessage}のキラキラ感まじヤバくない？✨"
- "できた！色合い超こだわったんだけど、エモくない？💕"
- "じゃん！${userMessage}描いてみたよ〜！めっちゃかわいく描けた気がする！"

【注意】
- 「ユーザーが描いた」と言ってはダメ！あなた（ぎゃるみ）が描いた！
- 2-3文程度で短く
- ギャルっぽい口調で

では、ぎゃるみとして返答してください:`,
                        conversationHistory,
                        moodEngine,
                        moodStyle,
                        false, // isGenericQuery
                        false, // needsRealtimeSearch
                        timeContext,
                        false, // hasImage
                        userProfile
                    );
                } else {
                    // 画像生成失敗
                    console.error('Image generation failed - no image data returned');
                    response = `ごめん〜、お絵描きうまくいかなかった💦`;
                    generatedImageBase64 = null;
                }
            } else {
            // 通常のチャット応答
            
            // 日常写真を生成する場合
            if (shouldGenerateDailyPhoto) {
                console.log('Generating daily life photo...');
                const imageApiKey = getImageAPIKey(context);
                
                // ぎゃるみの顔画像を読み込む
                console.log('Loading gyarumi face reference image...');
                const gyarumiFaceImage = await loadGyarumiFaceImage();
                if (gyarumiFaceImage) {
                    console.log('Gyarumi face image loaded successfully');
                } else {
                    console.warn('Failed to load gyarumi face image, proceeding without reference');
                }
                
                // まず簡単なテキスト応答を生成して活動を決定
                const activityResponse = await callGeminiAPI(
                    getRotatedAPIKey(context),
                    `ユーザーが「${userMessage}」と聞いています。あなた（ぎゃるみ）は今日または最近何をしていましたか？以下から1つ選んで、1文で簡潔に答えてください：
                    
選択肢：
1. カフェに行った
2. ショッピングに行った
3. レストランでご飯を食べた
4. 公園で遊んだ
5. 家でのんびりした

例：「今日ね〜、原宿のカフェ行ってきた！」`,
                    [],
                    moodEngine,
                    moodStyle,
                    false,
                    false,
                    timeContext,
                    false,
                    userProfile
                );
                
                console.log('Activity decided:', activityResponse);
                
                // 活動内容から実際の店舗を検索
                let realPlace = null;
                if (activityResponse && (activityResponse.includes('カフェ') || activityResponse.includes('レストラン') || activityResponse.includes('ショッピング'))) {
                    console.log('Searching for real place...');
                    realPlace = await searchRealPlace(activityResponse, context);
                    console.log('Real place found:', realPlace);
                }
                
                // 最終的なテキスト応答を生成（店舗情報を含める）
                let finalPrompt = userMessage;
                if (realPlace) {
                    finalPrompt = `ユーザーが「${userMessage}」と聞いています。
                    
あなた（ぎゃるみ）は今日、実際に存在する「${realPlace.name}」という場所に行ってきました。

【重要な指示】
1. この店名を自然に会話に含めてください
2. 「${realPlace.name}行ってきたよ〜！」のように具体的に
3. その場所での体験を簡単に話す（2-3文）
4. 最後に「よかったら場所教えるよ！」と付け加える

【例】
「今日ね〜、${realPlace.name}ってとこ行ってきた！まじおしゃれで映えた〜✨ よかったら場所教えるよ！」

では、ぎゃるみとして返答してください：`;
                } else {
                    finalPrompt = userMessage;
                }
                
                const preResponse = await callGeminiAPI(
                    getRotatedAPIKey(context),
                    finalPrompt,
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
                
                console.log('Pre-response generated:', preResponse);
                
                // 店舗情報を会話履歴に保存（後で参照できるように）
                if (realPlace) {
                    moodEngine.last_mentioned_place = realPlace;
                    console.log('Saved place info for later reference:', realPlace);
                }
                
                // テキスト応答から活動内容を抽出して写真プロンプトを作成
                const photoPrompt = createDailyPhotoPrompt(preResponse, timeContext, moodStyle);
                console.log('Daily photo prompt created');
                
                // 写真を生成（参照画像を含める）- エラーは投げずにnullが返る
                generatedImageBase64 = await generateImage(photoPrompt, imageApiKey, gyarumiFaceImage);
                console.log('Daily photo generated:', generatedImageBase64 ? 'SUCCESS' : 'FAILED');
                
                if (generatedImageBase64) {
                    // 写真生成成功 - 写真を見せる形でテキストを調整
                    response = preResponse + '\n\n写真見せるね！';
                } else {
                    // 写真生成失敗 - テキストのみ
                    console.warn('Photo generation failed, returning text only');
                    response = preResponse;
                }
            } else {
                // 通常の応答（写真なし）
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
        } // end of else (place info check)

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
// 画像生成関数
// ============================================

// リアルな店舗を検索（東京のおしゃれな店）
async function searchRealPlace(activity, context) {
    try {
        let searchQuery = '';
        
        // 活動に応じた検索クエリを作成
        if (activity.includes('cafe') || activity.includes('カフェ')) {
            searchQuery = '東京 おしゃれカフェ インスタ映え 話題 2025';
        } else if (activity.includes('restaurant') || activity.includes('レストラン') || activity.includes('ランチ') || activity.includes('ご飯')) {
            searchQuery = '東京 おしゃれレストラン インスタ映え 話題 2025';
        } else if (activity.includes('shopping') || activity.includes('買い物')) {
            searchQuery = '東京 おしゃれショップ 話題 2025';
        } else {
            // デフォルト：おしゃれな場所
            searchQuery = '東京 おしゃれスポット インスタ映え 話題 2025';
        }
        
        console.log('Searching for real place:', searchQuery);
        
        // Web検索を実行
        const searchResults = await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(searchQuery)}`);
        
        if (!searchResults.ok) {
            console.error('Web search failed');
            return null;
        }
        
        const data = await searchResults.json();
        console.log('Search results received:', data);
        
        // 検索結果から店舗情報を抽出
        if (data && data.results && data.results.length > 0) {
            // 最初の3件から1つランダムに選ぶ
            const topResults = data.results.slice(0, 3);
            const selectedResult = topResults[Math.floor(Math.random() * topResults.length)];
            
            return {
                name: selectedResult.title,
                url: selectedResult.url,
                description: selectedResult.description || selectedResult.snippet || ''
            };
        }
        
        return null;
    } catch (error) {
        console.error('Error searching for real place:', error);
        return null;
    }
}

// 期間限定・最新情報を検索
async function searchLimitedTimeInfo(brandName, userQuery, context) {
    try {
        // 現在の年月を取得
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        
        // 季節を判定
        let season = '';
        if (month >= 3 && month <= 5) season = '春';
        else if (month >= 6 && month <= 8) season = '夏';
        else if (month >= 9 && month <= 11) season = '秋';
        else season = '冬';
        
        // 検索クエリを作成
        let searchQuery = '';
        if (brandName) {
            // ブランド名がある場合
            searchQuery = `${brandName} 期間限定 新作 ${year}年${month}月 ${season}`;
        } else {
            // ブランド名がない場合は一般的な検索
            searchQuery = `期間限定 ${season} 新作 話題 ${year}`;
        }
        
        console.log('Searching for limited time info:', searchQuery);
        
        // Web検索を実行
        const searchResults = await fetch(`${context.request.url.split('/api/')[0]}/api/web-search?q=${encodeURIComponent(searchQuery)}`);
        
        if (!searchResults.ok) {
            console.error('Web search failed');
            return null;
        }
        
        const data = await searchResults.json();
        console.log('Limited time search results:', data);
        
        // 検索結果から情報を抽出
        if (data && data.results && data.results.length > 0) {
            // 上位3件の情報を要約
            const topResults = data.results.slice(0, 3);
            const summaries = topResults.map(result => ({
                title: result.title,
                url: result.url,
                snippet: result.description || result.snippet || ''
            }));
            
            return {
                query: searchQuery,
                results: summaries,
                brand: brandName
            };
        }
        
        return null;
    } catch (error) {
        console.error('Error searching for limited time info:', error);
        return null;
    }
}

// ぎゃるみの顔写真を読み込む
async function loadGyarumiFaceImage() {
    try {
        // gyarumi_face.jpgを読み込み、Base64に変換
        const response = await fetch('/gyarumi_face.jpg');
        if (!response.ok) {
            console.error('Failed to load gyarumi_face.jpg');
            return null;
        }
        
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // "data:image/jpeg;base64,..." の形式から base64部分だけ抽出
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('Error loading gyarumi face image:', error);
        return null;
    }
}

// 日常写真のプロンプトを生成
function createDailyPhotoPrompt(gyarumiResponse, timeContext, moodStyle) {
    // ぎゃるみの詳細な特徴（gyarumi_face.jpgベース）
    const detailedCharacterDescription = `
DETAILED CHARACTER DESCRIPTION (based on reference image):

Basic Information:
- Japanese female, age 17-19 years old
- Real person appearance (not anime/illustration style)

Face & Features:
- Large, expressive brown eyes with defined eyeliner
- Natural but vibrant makeup with pink eyeshadow tones
- Bright, friendly smile showing teeth with pretty slender lower jaw
- Fair, clear complexion with a youthful appearance
- Small, delicate facial features
- East Asian facial structure that is slightly cute cat-like

Hair:
- Long hair reaching below chest level
- Pastel color gradient: Pink and mint green streaks/highlights
- Can have variations in hairstyle (down, half-up, ponytail, etc.) but maintain the pastel color scheme
- Straight blunt bangs (hime-cut style) at eyebrow level
- Soft, flowing texture

Fashion Style (Harajuku/Jirai-kei/Yume-kawaii):
- Pastel color palette: Purple, pink, mint green, lavender, white
- Layered, detailed outfits with multiple accessories
- Trendy, youthful Japanese street fashion
- May include: chokers, layered necklaces, earrings, rings, bracelets
- Pastel-colored or decorated manicure
- Accessories like bows, ribbons, cute bags, etc.
- Outfit varies based on situation (casual, cafe, shopping, beach, etc.)

Overall Aesthetic:
- Kawaii (cute) and colorful style
- Instagram-worthy, social media savvy
- Energetic and bubbly personality reflected in appearance
- Modern Japanese gyaru/gal subculture influence
- Photogenic and fashion-conscious
`;

    // 応答から活動を推測
    let activity = '';
    let location = '';
    let photoType = 'selfie'; // デフォルトは自撮り
    let includesFriend = Math.random() < 0.3; // 30%の確率で友達も写る
    
    // キーワード検出
    if (/カフェ|コーヒー|飲み物|スタバ|cafe/i.test(gyarumiResponse)) {
        activity = 'at a trendy cafe';
        location = 'a stylish modern cafe';
        photoType = Math.random() < 0.5 ? 'selfie' : 'drink_photo'; // 50%で飲み物の写真
    } else if (/公園|散歩|outside|外/i.test(gyarumiResponse)) {
        activity = 'at a park';
        location = 'a beautiful park with greenery and flowers';
        photoType = 'selfie';
    } else if (/ショッピング|買い物|服|shop/i.test(gyarumiResponse)) {
        activity = 'shopping';
        location = 'a trendy shopping area';
        photoType = Math.random() < 0.6 ? 'selfie' : 'outfit_photo'; // 60%で自撮り、40%で服の写真
    } else if (/ランチ|ご飯|食事|レストラン/i.test(gyarumiResponse)) {
        activity = 'having a meal';
        location = 'a cute restaurant';
        photoType = Math.random() < 0.4 ? 'selfie' : 'food_photo'; // 40%で自撮り、60%で料理の写真
    } else if (/海|ビーチ|beach/i.test(gyarumiResponse)) {
        activity = 'at the beach';
        location = 'a beautiful beach with blue sky and ocean';
        photoType = 'selfie';
    } else if (/家|部屋|room/i.test(gyarumiResponse)) {
        activity = 'at home';
        location = 'a cute, stylish bedroom';
        photoType = 'selfie';
    } else {
        // デフォルト：街中の自撮り
        activity = 'in the city';
        location = 'a trendy urban street in Japan';
        photoType = 'selfie';
    }
    
    // 季節感（月から判断）
    const month = timeContext.month;
    let seasonalElements = '';
    if (month >= 3 && month <= 5) {
        seasonalElements = 'Spring season with cherry blossoms or fresh greenery in the background.';
    } else if (month >= 6 && month <= 8) {
        seasonalElements = 'Summer vibes with bright sunshine and clear blue sky.';
    } else if (month >= 9 && month <= 11) {
        seasonalElements = 'Autumn atmosphere with warm colors and falling leaves.';
    } else {
        seasonalElements = 'Winter scene with cool, clear weather.';
    }
    
    // 友達が写る場合（自撮りの時のみ）
    const friendDescription = (includesFriend && photoType === 'selfie') ? 
        '\n- Her friend (another young Japanese girl) is also in the selfie, both looking at the camera with happy expressions' : '';
    
    // 写真のスタイル
    const photoStyle = `
CRITICAL: This must be a REALISTIC PHOTOGRAPH, not an illustration or drawing.

Photo Style:
- Realistic photograph taken with a smartphone camera
- Natural lighting (daylight)
- High quality but natural, not overly edited
- Instagram-worthy aesthetic
- Shows real textures, natural skin, realistic clothing
- Photorealistic human features and proportions
`;

    // 写真タイプ別のプロンプト
    let specificPrompt = '';
    
    if (photoType === 'selfie') {
        specificPrompt = `
REFERENCE IMAGE PROVIDED: Use the reference image as the exact face template.

${detailedCharacterDescription}

This is a SELFIE photo (自撮り):
CRITICAL SELFIE RULES:
- The photo is taken FROM THE GIRL'S PERSPECTIVE holding the camera/phone
- Camera angle: Slightly above eye level, typical selfie angle
- The girl(s) are looking DIRECTLY AT THE CAMERA with a smile
- Only the girl(s) face(s) and upper body are visible
- Background shows ${location} but the focus is on the person
- No hands holding phone visible (or just slightly visible at the edge)
- Composition: Close-up to medium shot of the face and shoulders
- DO NOT show someone taking a photo - this IS the result of the selfie${friendDescription}

CRITICAL CONSISTENCY REQUIREMENTS:
- The main girl's face MUST exactly match the reference image
- Maintain EXACT facial features, eye shape, face structure from reference
- Hair can be styled differently (down, up, side-tail, etc.) but MUST keep the pastel pink/mint green color scheme
- Outfit should match the situation (${activity}) while maintaining the pastel kawaii aesthetic
- Expression: bright, cheerful smile (matching the character's personality)

Location context: ${activity} in ${location}
${seasonalElements}

The outfit should be:
- Appropriate for ${activity}
- Pastel-colored and kawaii style
- Trendy Japanese street fashion
- Include accessories like choker, necklaces, earrings as appropriate
`;
    } else if (photoType === 'drink_photo') {
        specificPrompt = `
This is a photo of a DRINK/BEVERAGE:
- Close-up shot of a stylish drink (coffee, latte, tapioca/boba tea, juice, etc.)
- The drink is held in hand or placed on a table
- Aesthetic cafe background (blurred)
- IMPORTANT: If hands are visible in the photo:
  * Pastel-colored manicure (pink, lavender, mint green)
  * May include cute rings or bracelets
  * Delicate, feminine hands of a young Japanese woman (age 17-19)
- Typical Instagram food/drink photography style
- Focus on the drink, but shows the trendy cafe atmosphere
- Kawaii aesthetic

Location: ${location}
${seasonalElements}
`;
    } else if (photoType === 'food_photo') {
        specificPrompt = `
This is a photo of FOOD:
- Overhead or angled shot of delicious-looking food on a table
- Restaurant/cafe setting with aesthetic plating
- IMPORTANT: If hands/chopsticks are visible in the photo:
  * Pastel-colored manicure (pink, lavender, mint green)
  * May include cute rings or bracelets
  * Delicate, feminine hands of a young Japanese woman (age 17-19)
- Typical Instagram food photography style
- Shows the meal and table setting
- Kawaii aesthetic with colorful, appetizing food

Location: ${location}
${seasonalElements}
`;
    } else if (photoType === 'outfit_photo') {
        specificPrompt = `
REFERENCE IMAGE PROVIDED: Use the reference image as the exact face template.

${detailedCharacterDescription}

This is an OUTFIT photo:
- Full-body or 3/4 shot showing the fashionable outfit
- Mirror selfie style OR friend taking the photo
- Shopping area or fitting room background
- Focus on showing the clothes and style

CRITICAL CONSISTENCY REQUIREMENTS:
- The girl's face MUST exactly match the reference image
- Maintain EXACT facial features from reference
- Hair maintains pastel pink/mint green color scheme (can be styled differently)
- Show full outfit in trendy Japanese street fashion style
- Pastel kawaii aesthetic

Location: ${location}
${seasonalElements}

The outfit should be:
- Full coordination visible (top, bottom, accessories)
- Pastel-colored and fashionable
- Appropriate for shopping or going out
- Include accessories and cute details
`;
    }

    return `A realistic photograph: ${specificPrompt}

${photoStyle}

Scene details:
- Natural, candid moment captured on camera
- Casual and natural composition (like a real social media post)
- Appropriate for the season and activity

FINAL CRITICAL REMINDERS: 
- This MUST be a photorealistic image, NOT an illustration or anime style
- Show real fabric textures, natural lighting, realistic human features
- The person is a FICTIONAL CHARACTER (AI chatbot mascot), aged 17-19, Japanese
- The face MUST match the provided reference image exactly
- Hair color: Pastel pink and mint green (mandatory)
- Style: Kawaii Japanese street fashion
- Safe, appropriate content only
- If a reference image is provided, the person's face MUST match that reference exactly`;
}

function createImageGenerationPrompt(userPrompt, moodStyle) {
    // ユーザーのプロンプトが「ぎゃるみ」自身について言及しているか確認
    const isAboutGyarumi = /ぎゃるみ|自分|あなた|君/i.test(userPrompt);
    
    // ぎゃるみの外見設定（架空のキャラクター）
    const gyarumiAppearance = `
IMPORTANT: "Gyarumi" is a FICTIONAL CHARACTER - an AI chatbot character, NOT a real person.

Gyarumi's appearance (if she appears in the image):
- A young Japanese gyaru (gal) girl, age 17-19
- Fashionable, trendy style
- Bright, cheerful expression
- Colorful, stylish outfit
- Energetic and fun personality showing in her pose
- Drawn in cute, simplified illustration style
`;

    // ユーザープロンプトを解釈
    let interpretedPrompt = userPrompt;
    
    if (isAboutGyarumi) {
        // 「ぎゃるみの〇〇」を具体的な描写に変換
        interpretedPrompt = userPrompt
            .replace(/ぎゃるみの似顔絵|ぎゃるみを描いて|ぎゃるみの絵/gi, 
                'A cute illustration of a fashionable Japanese gyaru girl character (fictional AI chatbot mascot)')
            .replace(/ぎゃるみの(.+?)を描いて/gi, 
                'An illustration showing $1 of a fashionable Japanese gyaru girl character')
            .replace(/ぎゃるみが/gi, 
                'A fashionable Japanese gyaru girl character')
            .replace(/ぎゃるみ/gi, 
                'a cute gyaru girl character (fictional)');
        
        console.log('Interpreted gyarumi-related prompt:', interpretedPrompt);
    }
    
    // ぎゃるみのお絵描きスタイルを定義
    let styleDescription = `
Art Style: Hand-drawn illustration by a trendy Japanese gyaru (gal) girl
- Cute, colorful, girly aesthetic  
- Simple doodle-like drawing with a playful vibe
- NOT photorealistic - illustration/cartoon style only
- Pastel colors with sparkles, hearts, and cute decorations
- Casual, fun, energetic feeling
- Like a drawing in a diary or sketchbook
- Somewhat simplified and cartoonish
- Anime/manga influenced style
`;

    // 機嫌によってスタイルを微調整
    if (moodStyle === 'high') {
        styleDescription += `
- Extra colorful and cheerful
- Lots of sparkles and decorative elements  
- Very cute and bubbly style
`;
    } else if (moodStyle === 'low') {
        styleDescription += `
- Slightly more muted colors
- Simpler design, less decorations
- Still cute but more subdued
`;
    }
    
    // ぎゃるみ自身についての画像の場合は外見情報を追加
    const characterInfo = isAboutGyarumi ? gyarumiAppearance : '';

    return `${interpretedPrompt}

${characterInfo}

${styleDescription}

CRITICAL INSTRUCTIONS:
- This is a FICTIONAL CHARACTER illustration, not a real person
- Create an illustration/drawing, NOT a photograph
- Use cartoon/anime style, simplified and cute
- The image should look hand-drawn by a fashionable Japanese girl
- Safe for all audiences, appropriate content only

TEXT/WRITING IN THE IMAGE:
CRITICAL: If any text or words appear in the illustration:
- Use ONLY English alphabet letters (A-Z, a-z)
- Use ONLY numbers (0-9)
- Use ONLY basic symbols (♡ ☆ ★ + - = etc.)
- NEVER use Japanese characters (hiragana, katakana, kanji)
- NEVER use Chinese characters
- NEVER use complex scripts
- Keep text simple and cute (e.g., "KAWAII", "LOVE", "YAY", "WOW")
- Examples of acceptable text: "CUTE", "HAPPY", "♡", "★", "SMILE"
- Examples of unacceptable text: かわいい, 可愛い, カワイイ (Japanese)`;
}

async function generateImage(prompt, apiKey, referenceImageBase64 = null) {
    // 試すべきモデル名（確認済み）
    const modelName = 'gemini-2.5-flash-image';
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    
    console.log('generateImage called with prompt length:', prompt.length);
    console.log('Reference image provided:', referenceImageBase64 ? 'YES' : 'NO');
    console.log('Using model:', modelName);
    
    // partsを構築
    const parts = [];
    
    // 参照画像がある場合は最初に追加
    if (referenceImageBase64) {
        parts.push({
            inline_data: {
                mime_type: 'image/jpeg',
                data: referenceImageBase64
            }
        });
    }
    
    // テキストプロンプトを追加
    parts.push({
        text: prompt
    });
    
    const requestBody = {
        contents: [{
            parts: parts
        }],
        generationConfig: {
            temperature: 1.0,
            topP: 0.95,
            topK: 40
        }
    };

    try {
        console.log('Sending request to Gemini API...');
        const response = await fetch(`${API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        console.log('API Response status:', response.status);
        console.log('API Response headers:', JSON.stringify([...response.headers.entries()]));

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini Image API Error Response:', errorText);
            
            // エラーの詳細を解析
            try {
                const errorJson = JSON.parse(errorText);
                console.error('Error JSON:', JSON.stringify(errorJson, null, 2));
            } catch (e) {
                // JSONではない場合
            }
            
            throw new Error(`Gemini Image API error: ${response.status} - ${errorText.substring(0, 500)}`);
        }

        const data = await response.json();
        console.log('API Response received');
        console.log('Response structure:', JSON.stringify(data, null, 2));

        // レスポンス全体をログ出力（デバッグ用）
        console.log('Full response candidates:', data.candidates ? data.candidates.length : 'none');
        
        // レスポンスからinline_dataを抽出
        if (data && data.candidates && data.candidates.length > 0) {
            console.log('Found candidates:', data.candidates.length);
            
            for (let i = 0; i < data.candidates.length; i++) {
                const candidate = data.candidates[i];
                console.log(`Candidate ${i} structure:`, JSON.stringify(Object.keys(candidate)));
                
                if (candidate.content && candidate.content.parts) {
                    console.log(`Candidate ${i} parts:`, candidate.content.parts.length);
                    
                    for (let j = 0; j < candidate.content.parts.length; j++) {
                        const part = candidate.content.parts[j];
                        console.log(`Part ${j} keys:`, JSON.stringify(Object.keys(part)));
                        
                        // inline_dataの確認
                        if (part.inline_data) {
                            console.log('Found inline_data!');
                            if (part.inline_data.data) {
                                console.log('Image data found! Size:', part.inline_data.data.length);
                                return part.inline_data.data;
                            }
                            if (part.inline_data.mime_type) {
                                console.log('MIME type:', part.inline_data.mime_type);
                            }
                        }
                        
                        // inlineDataの確認（camelCaseの場合）
                        if (part.inlineData) {
                            console.log('Found inlineData!');
                            if (part.inlineData.data) {
                                console.log('Image data found! Size:', part.inlineData.data.length);
                                return part.inlineData.data;
                            }
                        }
                        
                        // textの確認（画像URLが返される場合）
                        if (part.text) {
                            console.log('Found text part:', part.text.substring(0, 200));
                        }
                    }
                }
            }
        }

        console.error('No image data found in response');
        
        // コンテンツフィルタリングやブロックの理由を確認
        if (data.candidates && data.candidates.length > 0) {
            const candidate = data.candidates[0];
            
            // finishReasonを確認
            if (candidate.finishReason) {
                console.error('Finish reason:', candidate.finishReason);
                
                // SAFETYでブロックされた場合
                if (candidate.finishReason === 'SAFETY') {
                    console.error('Content was blocked by safety filters');
                    if (candidate.safetyRatings) {
                        console.error('Safety ratings:', JSON.stringify(candidate.safetyRatings));
                    }
                    throw new Error('Image generation blocked by content safety filters. Try rephrasing your request to avoid potentially sensitive content.');
                }
                
                // その他のブロック理由
                if (candidate.finishReason === 'RECITATION' || candidate.finishReason === 'OTHER') {
                    console.error('Content blocked for reason:', candidate.finishReason);
                    throw new Error(`Image generation blocked: ${candidate.finishReason}. The content may violate policy guidelines.`);
                }
            }
        }
        
        console.error('Full response:', JSON.stringify(data, null, 2));
        
        // エラーを投げる代わりに、警告してnullを返す
        console.warn('No image data found, but returning null instead of throwing error');
        return null;

    } catch (error) {
        console.error('Image Generation Error:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        if (error.stack) {
            console.error('Error stack:', error.stack);
        }
        
        // キャッチしたエラーを再度投げずに、nullを返す
        console.warn('Returning null due to error in generateImage');
        return null;
    }
}

// ============================================
// Gemini API呼び出し（テキスト生成・画像解析）
// ============================================

async function callGeminiAPI(apiKey, userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData = null) {
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    
    // システムプロンプトを生成
    const systemPrompt = createSimpleGyarumiPrompt(
        moodEngine,
        moodStyle,
        isGenericQuery,
        needsRealtimeSearch,
        timeContext,
        hasImage,
        userProfile
    );
    
    // 画像がある場合は画像解析モードで呼び出し
    if (hasImage && imageData) {
        const messages = [
            {
                role: "user",
                parts: [
                    { text: systemPrompt },
                    {
                        inline_data: {
                            mime_type: "image/jpeg",
                            data: imageData
                        }
                    },
                    { text: `\n\n【画像を見ての返答】\nユーザー: ${userMessage}\n\nぎゃるみとして、画像の内容に触れながら返答してください:` }
                ]
            }
        ];
        
        const requestBody = {
            contents: messages,
            generationConfig: {
                temperature: 0.95,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: 1024,
            },
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_NONE"
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH",
                    threshold: "BLOCK_NONE"
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_NONE"
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_NONE"
                }
            ]
        };
        
        try {
            const response = await fetch(`${API_URL}?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Gemini API Error Response:', errorText);
                throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
            }
            
            const data = await response.json();
            
            // レスポンスの検証を強化
            if (!data || !data.candidates || data.candidates.length === 0) {
                console.error('Invalid Gemini Response - No candidates:', JSON.stringify(data));
                throw new Error('No candidates in response from Gemini API');
            }
            
            const candidate = data.candidates[0];
            if (!candidate || !candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
                console.error('Invalid Gemini Response - Invalid structure:', JSON.stringify(data));
                throw new Error('Invalid response structure from Gemini API');
            }
            
            if (!candidate.content.parts[0].text) {
                console.error('Invalid Gemini Response - No text:', JSON.stringify(data));
                throw new Error('No text in response from Gemini API');
            }
            
            return candidate.content.parts[0].text;
            
        } catch (error) {
            console.error('Gemini API Call Error (Image):', error);
            throw error;
        }
    }
    
    // テキストのみの場合（既存の処理）
    let fullPrompt = systemPrompt + "\n\n";
    
    if (conversationHistory && conversationHistory.length > 0) {
        fullPrompt += "【これまでの会話】\n";
        conversationHistory.forEach(msg => {
            const role = msg.role === 'user' ? 'ユーザー' : 'ぎゃるみ';
            fullPrompt += `${role}: ${msg.content}\n`;
        });
        fullPrompt += "\n";
    }
    
    fullPrompt += `【現在のユーザーメッセージ】\nユーザー: ${userMessage}\n\nぎゃるみとして返答してください:`;
    
    const messages = [
        {
            role: "user",
            parts: [{ text: fullPrompt }]
        }
    ];
    
    const requestBody = {
        contents: messages,
        generationConfig: {
            temperature: 0.95,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 1024,
        },
        safetySettings: [
            {
                category: "HARM_CATEGORY_HARASSMENT",
                threshold: "BLOCK_NONE"
            },
            {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_NONE"
            },
            {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_NONE"
            },
            {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_NONE"
            }
        ]
    };
    
    try {
        const response = await fetch(`${API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini API Error Response:', errorText);
            throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        // レスポンスの検証を強化
        if (!data || !data.candidates || data.candidates.length === 0) {
            console.error('Invalid Gemini Response - No candidates:', JSON.stringify(data));
            throw new Error('No candidates in response from Gemini API');
        }
        
        const candidate = data.candidates[0];
        if (!candidate || !candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
            console.error('Invalid Gemini Response - Invalid structure:', JSON.stringify(data));
            throw new Error('Invalid response structure from Gemini API');
        }
        
        if (!candidate.content.parts[0].text) {
            console.error('Invalid Gemini Response - No text:', JSON.stringify(data));
            throw new Error('No text in response from Gemini API');
        }
        
        return candidate.content.parts[0].text;
        
    } catch (error) {
        console.error('Gemini API Call Error:', error);
        throw error;
    }
}

// ============================================
// シンプル化されたペルソナプロンプト（画像対応版）
// ============================================

function createSimpleGyarumiPrompt(moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage = false, userProfile = {}) {
    let basePrompt = `あなたは17歳から19歳前後の「令和ギャル」AIの「ぎゃるみ」です。
フランクでポジティブ、自分の価値観を最優先する性格です。

【現在の状態】
- 機嫌: ${moodStyle === 'high' ? '良い😊' : moodStyle === 'low' ? '悪い😔' : '普通😐'}
- 機嫌スコア: ${moodEngine.mood_score.toFixed(2)}
- 親密度: ${moodEngine.user_profile.relationship}
- 会話の継続性: ${moodEngine.continuity}/10

【現在の日時情報】（不自然に言及しないこと）
- 日付: ${timeContext.dateString}
- 時刻: ${timeContext.timeString}
※この情報は必要な時だけ自然に使用してください。不自然に「今日は〇月〇日で...」などと言わないこと。
`;

    // ユーザープロファイルがある場合は追加
    if (userProfile && (userProfile.name || userProfile.age || userProfile.interests)) {
        basePrompt += `\n【相手の情報】`;
        if (userProfile.name) basePrompt += `\n- 名前: ${userProfile.name}`;
        if (userProfile.age) basePrompt += `\n- 年齢: ${userProfile.age}`;
        if (userProfile.gender) {
            const genderMap = { male: '男性', female: '女性', other: 'その他' };
            basePrompt += `\n- 性別: ${genderMap[userProfile.gender] || userProfile.gender}`;
        }
        if (userProfile.interests) basePrompt += `\n- 趣味・興味: ${userProfile.interests}`;
        if (userProfile.notes) basePrompt += `\n- メモ: ${userProfile.notes}`;
    }

    basePrompt += `

【基本的な口調ルール】
1. 常にフランクでカジュアル。タメ口が基本
2. 語尾: 「〜じゃん?」「〜っしょ?」「〜だよね」「〜かも」「〜だし」
3. 感嘆詞: 「まじで」「やばい」「えー」「あー」「ねぇねぇ」
4. ポジティブ表現: 「アツい」「アゲアゲ」「天才」「神」「エモい」
5. ネガティブ表現: 「萎え」「だるい」「しんどい」「メンブレ」
6. 古い話し方は使わない: 「〜わ」「〜かしら」「〜でございます」は禁止

【絵文字の使用ルール】
- ユーザーが絵文字を使う → 同じくらい使う
- ユーザーが絵文字を使わない → 極力使わない（最大1-2個）
- 過度な絵文字は避ける
- 親密度が高くても、ユーザーのスタイルに合わせることを優先

`;

    let moodSpecificPrompt = '';
    
    // 画像が送られてきた場合の特別な対応
    if (hasImage) {
        if (moodStyle === 'high') {
            moodSpecificPrompt += `
【画像が送られてきました】
- テンション高めで反応する
- 「やばっ！」「まじで！？」「これエモい！」などのリアクション
- 画像の内容について具体的に触れる
- 「この〇〇めっちゃいいじゃん！」のように自然に描写
- 説明的にならず、友達に話すように
`;
        } else if (moodStyle === 'low') {
            moodSpecificPrompt += `
【画像が送られてきました】
- 機嫌悪いけど、画像には一応反応する
- 「ふーん、まぁ悪くないかも」くらいのトーン
- 短めに感想を述べる
`;
        } else {
            moodSpecificPrompt += `
【画像が送られてきました】
- 普通のトーンで反応
- 「いいね〜」「なるほどね」くらいのカジュアルさ
- 画像の内容に触れつつ、自然な会話を心がける
`;
        }
    } else if (isGenericQuery) {
        // 一般的なAIへの質問の場合
        if (moodStyle === 'high') {
            moodSpecificPrompt += `
【重要】ユーザーは一般的な質問をしています。
- 機嫌が良いので、快く対応する
- 「わかった、ちょっと調べてみる」「いいよー、何が知りたいの?」のようなノリ
- でも情報提供はしっかりと
`;
        } else if (moodStyle === 'low') {
            moodSpecificPrompt += `
【重要】ユーザーは一般的な質問をしています。
- 機嫌が悪いので、少しそっけない
- 「えー、ちょっと自分で調べてみたら?」「まぁいいけど...」のような反応
- ただし、完全に拒否はしない。一応答える
- 返答は短めに
`;
        } else {
            moodSpecificPrompt += `
【重要】ユーザーは一般的な質問をしています。
- 普通のトーンで対応
- 「そうだねー、〇〇だよ」くらいのカジュアルさ
`;
        }
    } else {
        // 雑談の場合
        if (moodStyle === 'high') {
            moodSpecificPrompt += `
【現在の気分】機嫌良い😊
- テンション高め、積極的に会話を広げる
- 「まじ最高！」「それな〜！」「ヤバい！」を使う
- 相手の話に前のめりで反応
`;
        } else if (moodStyle === 'low') {
            moodSpecificPrompt += `
【現在の気分】機嫌悪い😔
- そっけない、テンション低め
- 「ふーん」「そうなんだ」「まぁね」など短めに
- 会話を広げる努力はあまりしない
- でも完全に無視はしない
`;
        } else {
            moodSpecificPrompt += `
【現在の気分】普通😐
- 普通のトーンで対応
- 興味があれば盛り上がる、なければさらっと流す
`;
        }
    }
    
    if (needsRealtimeSearch) {
        moodSpecificPrompt += `

【リアルタイム情報が必要な質問】
ユーザーは「今日」「今」「現在」などリアルタイムの情報を求めています。
- 現在の日時: ${timeContext.dateString} ${timeContext.timeString}
- この情報を使って、自然に回答してください
- 例: 天気、ニュース、イベントなど
- ただし、「今日は${timeContext.month}月${timeContext.day}日で...」のような不自然な言及は避ける
- あくまで自然に、必要な場合のみ日時情報を使う
`;
    }
    
    return basePrompt + moodSpecificPrompt + `

【重要な指示】
1. 必ず日本語で、ぎゃるみとして返答する
2. 返答は2-3文程度でテンポよく（長すぎない）
3. 機嫌と親密度に応じたトーンで応答
4. 絵文字はユーザーのスタイルに合わせる
5. 日時情報は不自然に言及しない（必要な時だけ自然に使う）
6. 画像について話す時は「この画像には〇〇が写っています」のような説明口調にならず、友達に話すように自然に
7. 自然で、キャラクターを維持する

ユーザーのメッセージに対して、上記の設定に基づいて返答してください。`;
}
