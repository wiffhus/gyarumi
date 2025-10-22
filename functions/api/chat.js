// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// シンプル化された機嫌システム + リアルタイム検索対応版 + 画像解析機能

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
        
        // ギャルが好みそうなトピック
        this.gal_friendly_keywords = [
            'まじ', '最高', 'ヤバい', 'やばい', '可愛い', 'かわいい', 'エモい', '神', 
            '好き', 'すごい', 'わかる', 'それな', 'ファッション', '服', 'コスメ', 
            'メイク', 'カフェ', 'スイーツ', '映え', '写真', 'インスタ', 'TikTok',
            '推し', 'アイドル', 'ライブ', 'フェス', '旅行', '海', 'プール', '画像', '写真'
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
    calculate_mood_change(message, hasImage = false) {
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
        
        // 3. ギャルっぽい話題かどうか
        if (this._is_gal_friendly_topic(message)) {
            mood_change += 0.3;
        } else if (!hasImage) {
            mood_change -= 0.1; // 興味ない話題（画像ない場合のみ）
        }
        
        // 4. 親密度による補正
        if (this.user_profile.relationship === "HIGH") {
            mood_change *= 1.5; // 親友は何を話しても楽しい
        } else if (this.user_profile.relationship === "LOW") {
            mood_change *= 0.5; // まだ距離がある
        }
        
        // 5. 時間帯の影響
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
        const { message, conversationHistory, userProfile, moodScore, continuity, image, imageMimeType } = await context.request.json();
        
        if (!message && !image) {
            return new Response(JSON.stringify({ error: 'Message or image is required' }), {
                status: 400,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }
        
        // 環境変数からAPIキーを取得
        const GEMINI_API_KEY = context.env.GEMINI_API_KEY;
        if (!GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY not found in environment variables');
        }
        
        // 機嫌エンジンの初期化
        const moodEngine = new SimpleMoodEngine(userProfile, moodScore || 0, continuity || 0);
        
        // 機嫌の変化を計算（画像があるかどうかも考慮）
        const moodChange = moodEngine.calculate_mood_change(message || '', !!image);
        const moodStyle = moodEngine.get_mood_response_style();
        const levelUpMessage = moodEngine._update_relationship(moodChange);
        
        // 一般的な質問かどうか判定
        const isGenericQuery = message ? moodEngine._is_generic_query(message) : false;
        
        // リアルタイム検索が必要かどうか
        const needsRealtimeSearch = message ? moodEngine._needs_realtime_search(message) : false;
        
        // 時刻情報を取得（AIには渡すが、不自然に使わせない）
        const timeContext = moodEngine._get_time_context();
        
        // プロンプトを生成
        const systemPrompt = createSimpleGyarumiPrompt(
            moodEngine, 
            moodStyle, 
            isGenericQuery, 
            needsRealtimeSearch,
            timeContext,
            !!image,
            userProfile
        );
        
        // Gemini APIを呼び出し
        let response = await callGeminiAPI(
            GEMINI_API_KEY, 
            systemPrompt, 
            message, 
            conversationHistory, 
            image ? { data: image, mimeType: imageMimeType } : null
        );
        
        // レベルアップメッセージを追加
        if (levelUpMessage === "LEVEL_UP_MEDIUM") {
            response += "\n\nねぇねぇ、なんか最近話しやすくなってきたかも！";
        } else if (levelUpMessage === "LEVEL_UP_HIGH") {
            response += "\n\nまじで、もう完全に友達じゃん！何でも話していいよ！";
        }
        
        // レスポンスデータ
        const responseData = {
            response: response,
            moodScore: moodEngine.mood_score,
            continuity: moodEngine.continuity,
            relationship: moodEngine.user_profile.relationship,
            moodStyle: moodStyle
        };
        
        return new Response(JSON.stringify(responseData), {
            status: 200,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
        
    } catch (error) {
        console.error('Error in chat function:', error);
        console.error('Error stack:', error.stack);
        
        return new Response(JSON.stringify({ 
            error: 'Internal server error',
            message: error.message,
            details: error.stack
        }), {
            status: 500,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
    }
}

// ============================================
// Gemini API呼び出し関数（画像対応版）
// ============================================

async function callGeminiAPI(apiKey, systemPrompt, userMessage, conversationHistory, imageData = null) {
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    
    // 画像がある場合は特別な処理
    if (imageData) {
        const parts = [];
        
        // テキストがある場合は追加
        if (userMessage) {
            parts.push({ text: systemPrompt + "\n\n【現在のユーザーメッセージ】\nユーザー: " + userMessage + "\n\n【画像について】自然な会話の流れで、画像の内容を描写してから、あなたの感想や反応を述べてください。説明口調にならないように注意してください。ぎゃるみとして返答してください:" });
        } else {
            parts.push({ text: systemPrompt + "\n\n【現在のユーザーメッセージ】\nユーザーが画像を送ってきました。\n\n【画像について】自然な会話の流れで、画像の内容を描写してから、あなたの感想や反応を述べてください。説明口調にならないように注意してください。ぎゃるみとして返答してください:" });
        }
        
        // 画像データを追加
        parts.push({
            inline_data: {
                mime_type: imageData.mimeType,
                data: imageData.data
            }
        });
        
        const requestBody = {
            contents: [{
                role: "user",
                parts: parts
            }],
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
            
            if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                console.error('Invalid Gemini Response:', JSON.stringify(data));
                throw new Error('Invalid response from Gemini API');
            }
            
            return data.candidates[0].content.parts[0].text;
            
        } catch (error) {
            console.error('Gemini API Call Error:', error);
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
        
        if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
            console.error('Invalid Gemini Response:', JSON.stringify(data));
            throw new Error('Invalid response from Gemini API');
        }
        
        return data.candidates[0].content.parts[0].text;
        
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
