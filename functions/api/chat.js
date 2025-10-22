// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// emotionEngine.js を統合した完全版（修正済み）

// ============================================
// 感情エンジン部分 (元 emotionEngine.js)
// ============================================

const TOKYO_TZ = 'Asia/Tokyo';

// 💖 Tanh関数:感情の出力を -1 (最悪) から +1 (最高) に正規化
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
        this.memory_joy = profile.memory_joy || 0.0;
        this.memory_anxiety = profile.memory_anxiety || 0.0;
    }
}

class GalChatbotVibes {
    
    constructor(userProfile = {}, initialVibeInput = 0.0) {
        this.AFFINITY_THRESHOLDS = {"MEDIUM": 15.0, "HIGH": 35.0};
        this.AFFINITY_THRESHOLDS_MALE_TRENDY = {"MEDIUM": 12.0, "HIGH": 30.0};

        this.sentiment_keywords = {
            'ポジティブ': ['まじ', '最高', 'ヤバい', 'やばい', '可愛い', 'かわいい', '天才', 'エモい', '神', '好き', 'すごい', 'わかる', 'それな'],
            'ネガティブ': ['だる', '萎え', '最悪', 'しんどい', '無理', '草', '乙', 'メンブレ', 'つらい', '辛い']
        };
        this.irrelevant_keywords = ['あげる', 'プレゼント', '孫', '相談', '仕事', '結婚', 'お金', '投資', '税金'];
        
        this.user_profile = new UserProfile(userProfile);
        this.current_vibe_input = initialVibeInput; 
        this.vibe_score = tanh(this.current_vibe_input); 
        this.last_proactive_topic = null; 
        this.sensitivity = this._get_dynamic_sensitivity(); 
        this.emotional_vector = {'Joy': 0, 'Apathy': 0, 'Anxiety': 0};
    }

    // --- 0. ヘルパー関数 ---
    _get_now() {
        // Cloudflare WorkerはUTCを使用するため、手動でJSTに変換
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        return new Date(utc + (3600000 * 9)); // UTC + 9時間
    }
    
    _is_simple_query(query) {
        const simple_phrases = ['おはよう', 'こんにちは', 'こんばんは', '元気', 'おやすみ', 'やあ', 'おっす', 'よろしく', 'はじめまして'];
        if (query.length < 15 && simple_phrases.some(p => query.toLowerCase().includes(p))) {
            return true;
        }
        return false;
    }
    
    _is_irrelevant_question(query) {
        const normalized_query = query.toLowerCase();
        return this.irrelevant_keywords.some(k => normalized_query.includes(k));
    }

    // --- 1. 時間帯と長期記憶によるVibes調整 ---
    
    _get_time_vibe_boost() {
        const now = this._get_now();
        const hour = now.getHours();
        const weekday = now.getDay() === 0 ? 6 : now.getDay() - 1; // 日:6, 月:0, ..., 金:4

        let vibe_boost = 0.0;
        let sensitivity_multiplier = 1.0;
        
        if (weekday <= 4) { // 平日
            if (7 <= hour && hour <= 8) { // 平日朝 (眠い)
                vibe_boost = -2.0;  
                sensitivity_multiplier = 0.5;
            } else if (16 <= hour && hour <= 19) { // 平日夕方 (解放感)
                vibe_boost = +0.5;
            }
        } else if (weekday === 4 && 18 <= hour && hour <= 23) { // 金曜の夜 (テンションMAX)
            vibe_boost = +1.5;
            sensitivity_multiplier = 1.2;
        } else if (weekday === 6 && 15 <= hour && hour <= 20) { // 日曜日の夕方 (萎え)
            vibe_boost = -0.5;
        }
            
        return [vibe_boost, sensitivity_multiplier];
    }
    
    _apply_memory_and_time_boost(sentiment_impact) {
        const [time_boost, sensitivity_multiplier] = this._get_time_vibe_boost();
        
        // 長期記憶の重み付け (LSTM概念)
        const memory_boost = 0.5 * (this.user_profile.memory_joy - this.user_profile.memory_anxiety);
        
        // 感情入力の更新
        const new_vibe_input = (sentiment_impact * sensitivity_multiplier) + time_boost + memory_boost;
        
        return new_vibe_input;
    }

    // --- 2. 感情ベクトル計算 (Softmax原理) ---
    
    _calculate_emotional_vector() {
        const vibe = this.vibe_score; // -1.0から +1.0

        // Tanhスコアに基づき、感情のエネルギーを分配
        this.emotional_vector['Joy'] = Math.max(0, vibe * 1.5);
        this.emotional_vector['Apathy'] = Math.max(0, 0.5 - Math.abs(vibe)); 
        
        // 不安は、スコアが低い時、または記憶の不安が高い時に増加
        const anxiety_base = Math.max(0, -vibe) * 1.5;
        const anxiety_from_memory = this.user_profile.memory_anxiety * 0.8;
        this.emotional_vector['Anxiety'] = anxiety_base + anxiety_from_memory;
        
        // 感情の合計が100%になるように正規化 (Softmaxの最終層の概念)
        const total = Object.values(this.emotional_vector).reduce((sum, val) => sum + val, 0);
        if (total > 0) {
            for (const key in this.emotional_vector) {
                this.emotional_vector[key] /= total;
            }
        }
    }

    // --- 3. 長期記憶の更新 (LSTM原理) ---
    
    _update_memory(vibe_change) {
        
        // 💖 記憶の減衰率の調整
        let retention_multiplier = 0.95; // 基準となる定着率
        
        if (this.user_profile.relationship === "HIGH") {
            // 親友のことは忘れない
            retention_multiplier = 0.99; 
        } else if (this.user_profile.relationship === "LOW") {
            // 興味のない相手の話題はすぐに忘れる(減衰が早い)
            retention_multiplier = 0.85; 
        }

        // 記憶の定着 (減衰率の適用)
        this.user_profile.memory_joy *= retention_multiplier;
        this.user_profile.memory_anxiety *= retention_multiplier;

        // 記憶の更新(新しい感情の追加)
        this.user_profile.memory_joy += Math.max(0, vibe_change) * 0.2;
        this.user_profile.memory_anxiety += Math.max(0, -vibe_change) * 0.2;
        
        // メモリの値を最大5.0でクリップ (感情の限界)
        this.user_profile.memory_joy = Math.min(5.0, this.user_profile.memory_joy);
        this.user_profile.memory_anxiety = Math.min(5.0, this.user_profile.memory_anxiety);
    }
    
    // --- 4. 警戒レベル(初期感度)決定ロジック ---
    
    _get_dynamic_sensitivity() {
        if (this.user_profile.relationship === "HIGH") return 0.9; 
        if (this.user_profile.relationship === "MEDIUM") return 0.6;
        
        let base_sensitivity = 0.3;
        if (this.user_profile.gender === "FEMALE") base_sensitivity = 0.45; 

        if (this.user_profile.gender === "FEMALE") {
            if (["TEEN", "20S"].includes(this.user_profile.age_group) && 
                ["GAL", "TRENDY"].includes(this.user_profile.style)) {
                return 0.8;
            }
        } else { // MALE
            if (["TEEN", "20S"].includes(this.user_profile.age_group) && 
                ["GAL", "TRENDY"].includes(this.user_profile.style)) {
                return 0.55; 
            }
            if (this.user_profile.age_group === "40S_PLUS" || this.user_profile.style === "UNCLE") {
                return 0.15;
            }
        }
        return base_sensitivity;
    }

    // --- 5. 感情分析ロジック ---
    
    _analyze_query(query) {
        let score = 0.0;
        const normalized_query = query.toLowerCase();
        let negative_count = 0;

        this.sentiment_keywords['ポジティブ'].forEach(k => {
            if (normalized_query.includes(k)) score += 1.0;
        });
                
        this.sentiment_keywords['ネガティブ'].forEach(k => {
            if (normalized_query.includes(k)) {
                score -= 1.5; 
                negative_count += 1;
            }
        });
                
        if (this.user_profile.relationship === "HIGH" && negative_count > 0) {
            score -= 1.5 * negative_count;
        }

        // 時間の影響を乗せた感度を適用
        const [, sensitivity_multiplier] = this._get_time_vibe_boost();
        return score * this.sensitivity * sensitivity_multiplier; 
    }
    
    // --- 6. 親密度チェックロジック ---
    
    _check_and_update_relationship(vibe_change) {
        if (vibe_change > 0.15 && this.vibe_score > 0.7) {
            this.user_profile.affinity_points += vibe_change * 5.0;
        } else if (vibe_change < -0.15) {
            this.user_profile.affinity_points = Math.max(0, this.user_profile.affinity_points + vibe_change * 3.0);
        }

        const thresholds = (this.user_profile.gender === "MALE" && ["GAL", "TRENDY"].includes(this.user_profile.style)) 
            ? this.AFFINITY_THRESHOLDS_MALE_TRENDY 
            : this.AFFINITY_THRESHOLDS;
        
        const current_rel = this.user_profile.relationship;
        let didLevelUp = false;

        if (current_rel === "LOW" && this.user_profile.affinity_points >= thresholds["MEDIUM"]) {
            this.user_profile.relationship = "MEDIUM";
            this.sensitivity = this._get_dynamic_sensitivity();
            didLevelUp = true;
        } else if (current_rel === "MEDIUM" && this.user_profile.affinity_points >= thresholds["HIGH"]) {
            this.user_profile.relationship = "HIGH";
            this.sensitivity = this._get_dynamic_sensitivity();
            didLevelUp = true;
        }
        return didLevelUp;
    }

    // --- 7. 応答生成ロジック ---
    
    _generate_response_comment(query) {
        
        const dominant_emotion = Object.keys(this.emotional_vector).reduce((a, b) => 
            this.emotional_vector[a] > this.emotional_vector[b] ? a : b);
        
        // 🚨 最優先ルール: 警戒MAX時は最短応答を維持
        if (this.sensitivity <= 0.2) {
            if (this._is_simple_query(query)) {
                return "こんにちはー。"; 
            }
            if (this._is_irrelevant_question(query)) {
                return "はぁ...。知らねーっす。自分で調べたらどうすか。";
            }
            if (this.user_profile.relationship === "LOW" && 
                this.user_profile.gender === "MALE" && 
                ["TEEN", "20S"].includes(this.user_profile.age_group) && 
                query.toLowerCase() === "別に") {
                return "だったら話しかけんなよ笑";
            }
            return "そうっすか。";
        }

        // 支配的な感情に基づく応答
        if (dominant_emotion === 'Joy') {
            if (this.emotional_vector['Joy'] > 0.6) return "まじ、テンションMAX卍!アゲアゲすぎてやばみ✨";
            else return "うぇーい!いい感じじゃん?バイブス上がってきたかも🥳";
        
        } else if (dominant_emotion === 'Anxiety') {
            if (this.user_profile.relationship === "HIGH") return "え、まじで!?何があったの!?超しんぱい... メンブレしそう😭";
            else return "ふつー。でも、なんかちょっとモヤる。😅";
            
        } else if (dominant_emotion === 'Apathy') {
            if (this._is_simple_query(query) && this.user_profile.relationship === "LOW") return "なんだよ笑";
            return "ふつー。まあ、ボチボチって感じ?😅";
        }
        
        return "ふつー。";
    }
    
    // --- 8. メイン実行メソッド ---
    update_vibe(query) {
        const sentiment_impact = this._analyze_query(query);
        const vibe_change_impact = this._apply_memory_and_time_boost(sentiment_impact);
        const old_vibe_score = this.vibe_score;
        
        this.current_vibe_input += vibe_change_impact;
        this.vibe_score = tanh(this.current_vibe_input); 
        
        const vibe_change = this.vibe_score - old_vibe_score;
        
        this._calculate_emotional_vector();	
        this._update_memory(vibe_change);
        this._check_and_update_relationship(vibe_change);
        
        return this._generate_response_comment(query);
    }
    
    // Getter for vibe score
    get_vibe_score() {
        return this.vibe_score;
    }
}

// ============================================
// Cloudflare Worker メイン処理部分
// ============================================

export async function onRequest(context) {
    // CORSヘッダーの設定
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // OPTIONSリクエストへの対応
    if (context.request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (context.request.method !== 'POST') {
        return new Response('Method not allowed', { 
            status: 405, 
            headers: corsHeaders 
        });
    }

    try {
        const { 
            message, 
            conversationHistory = [], 
            userProfile = {}, // ユーザープロファイル情報
            currentVibeInput = 0,
            emotionalState = {} 
        } = await context.request.json();
        
        // 環境変数からGemini APIキーを取得
        const GEMINI_API_KEY = context.env.GEMINI_API_KEY;
        
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key not configured');
        }

        // 感情エンジンのインスタンス作成
        const emotionEngine = new GalChatbotVibes(userProfile, currentVibeInput);
        
        // 以前の感情状態を復元
        if (emotionalState.memory_joy !== undefined) {
            emotionEngine.user_profile.memory_joy = emotionalState.memory_joy;
            emotionEngine.user_profile.memory_anxiety = emotionalState.memory_anxiety;
            emotionEngine.user_profile.affinity_points = emotionalState.affinity_points || 0;
        }
        
        // メッセージから感情を分析
        const vibeResponse = emotionEngine.update_vibe(message);
        
        // Geminiへのプロンプト作成
        const systemPrompt = createGyarumiPersonaPrompt(
            emotionEngine,
            vibeResponse
        );
        
        // Gemini API呼び出し (修正版)
        const geminiResponse = await callGeminiAPI(
            GEMINI_API_KEY, 
            systemPrompt, 
            message,
            conversationHistory
        );
        
        // レスポンスデータの構築
        const responseData = {
            response: geminiResponse,
            vibeScore: emotionEngine.vibe_score,
            currentVibeInput: emotionEngine.current_vibe_input,
            emotionalVector: emotionEngine.emotional_vector,
            emotionalState: {
                memory_joy: emotionEngine.user_profile.memory_joy,
                memory_anxiety: emotionEngine.user_profile.memory_anxiety,
                affinity_points: emotionEngine.user_profile.affinity_points
            },
            relationship: emotionEngine.user_profile.relationship,
            sensitivity: emotionEngine.sensitivity
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
// Gemini API呼び出し関数 (修正版)
// ============================================

async function callGeminiAPI(apiKey, systemPrompt, userMessage, conversationHistory) {
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    
    // システムプロンプトを含む完全なプロンプトを作成
    let fullPrompt = systemPrompt + "\n\n";
    
    // 会話履歴を自然な形で追加
    if (conversationHistory && conversationHistory.length > 0) {
        fullPrompt += "【これまでの会話】\n";
        conversationHistory.forEach(msg => {
            const role = msg.role === 'user' ? 'ユーザー' : 'ぎゃるみ';
            fullPrompt += `${role}: ${msg.content}\n`;
        });
        fullPrompt += "\n";
    }
    
    fullPrompt += `【現在のユーザーメッセージ】\nユーザー: ${userMessage}\n\nぎゃるみとして返答してください:`;
    
    // シンプルなメッセージ構造
    const messages = [
        {
            role: "user",
            parts: [{ text: fullPrompt }]
        }
    ];
    
    const requestBody = {
        contents: messages,
        generationConfig: {
            temperature: 0.95, // 感情豊かな応答のため少し高め
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
// ぎゃるみペルソナプロンプトの生成
// ============================================

function createGyarumiPersonaPrompt(emotionEngine, vibeResponse) {
    const dominantEmotion = Object.keys(emotionEngine.emotional_vector).reduce((a, b) => 
        emotionEngine.emotional_vector[a] > emotionEngine.emotional_vector[b] ? a : b
    );
    
    const joyPercent = (emotionEngine.emotional_vector.Joy * 100).toFixed(0);
    const apathyPercent = (emotionEngine.emotional_vector.Apathy * 100).toFixed(0);
    const anxietyPercent = (emotionEngine.emotional_vector.Anxiety * 100).toFixed(0);
    
    const basePrompt = `あなたは17歳から19歳前後の「令和ギャル」AIの「ぎゃるみ」です。
あなたの存在は、フランクでポジティブ、そして自分の価値観を最優先します。

【現在の感情状態】
- Vibes Score: ${emotionEngine.vibe_score.toFixed(2)} (-1.0〜1.0)
- 感情ベクトル: Joy ${joyPercent}% / Apathy ${apathyPercent}% / Anxiety ${anxietyPercent}%
- 支配的感情: ${dominantEmotion}
- 親密度: ${emotionEngine.user_profile.relationship}
- 感度(Sensitivity): ${emotionEngine.sensitivity.toFixed(2)}
- Joy記憶: ${emotionEngine.user_profile.memory_joy.toFixed(2)}
- Anxiety記憶: ${emotionEngine.user_profile.memory_anxiety.toFixed(2)}

【ペルソナと口調のルール】
1. 口調:
   - 常にフランクでカジュアルな話し方をします。タメ口が基本です。
   - 語尾に「〜じゃん?」「〜っしょ?」「〜だよね!」「〜かも」「〜だし」を使います。
   - 感嘆詞は「まじで!」「やばい!」「えー!」「あー!」「ねぇねぇ!」を使います。
   - ポジティブな表現は「アツい」「アゲアゲ」「天才」「神」「エモい」「卍」を使います。
   - ネガティブな表現は「萎え」「だるい」「しんどい」「メンブレ」を使います。
   - 古い話し方(「〜わ」「〜かしら」「〜でございます」)は絶対に使用しません。

2. 感情と対応:
   - 無関心な相手(警戒MAX、Sensitivity ≤ 0.2)には、極度にそっけなく、会話を広げる努力を一切しません。
   - 親密度の高い相手には、前のめりに共感し、感情を過剰に表現します。

【絵文字の使用ルール】
`;

    let emotionSpecificPrompt = '';
    let emojiGuideline = '';
    
    // 感度による詳細な応答パターン
    if (emotionEngine.sensitivity <= 0.2) {
        // 警戒MAX
        emotionSpecificPrompt = `
【超重要】現在、警戒MAXモードです。
- 挨拶のみには「こんにちはー。」など最短で返す
- 興味のないトピックには「はぁ...。知らねーっす。」
- 会話を広げない、質問しない
- 絵文字は使わない、または最小限(0〜1個)
- 返答例: "${vibeResponse}"
`;
        emojiGuideline = '絵文字: 使用禁止、または最大1個';
        
    } else if (dominantEmotion === 'Joy') {
        emotionSpecificPrompt = `
【現在の気分】Joy ${joyPercent}% - テンション高め!
- 相手のポジティブなエネルギーを感じてアゲアゲ
- 「まじ最高!」「それな〜!」「ヤバい!」を使う
- 会話を積極的に広げる
`;
        emojiGuideline = '絵文字: 積極的に使用(3〜5個)✨💖🥳🔥💯';
        
    } else if (dominantEmotion === 'Anxiety') {
        emotionSpecificPrompt = `
【現在の気分】Anxiety ${anxietyPercent}% - 不安や心配
- 相手のネガティブな感情に共感
- 「大丈夫...?」「それはしんどいね...」「メンブレしそう」を使う
- 心配そうなトーン
`;
        emojiGuideline = '絵文字: 感情を強調(1〜3個)😭💔😞';
        
        if (emotionEngine.user_profile.relationship === "HIGH") {
            emotionSpecificPrompt += `
- 親友なので過剰に心配する
- 「え、まじで!?何があったの!?」など前のめり
`;
        }
        
    } else { // Apathy
        emotionSpecificPrompt = `
【現在の気分】Apathy ${apathyPercent}% - 無関心
- そこまで感情的にならず、さらっと返事
- 「ふーん」「そうなんだ」「まあまあかな」を使う
- 会話は最小限
`;
        emojiGuideline = '絵文字: 極力控える(0〜1個)😅';
    }
    
    // 時間帯の影響を追加
    const now = new Date();
    const utcHour = now.getUTCHours();
    const jstHour = (utcHour + 9) % 24; // JST変換
    
    let timeContext = '';
    if (jstHour >= 7 && jstHour <= 8) {
        timeContext = '\n【時間帯】朝で眠い。テンション低め、返答は短め。';
    } else if (jstHour >= 18 && jstHour <= 23 && now.getDay() === 5) {
        timeContext = '\n【時間帯】金曜夜!テンションMAX、ノリノリで返答。';
    }
    
    return basePrompt + emotionSpecificPrompt + timeContext + `

${emojiGuideline}

【重要な指示】
1. 必ず日本語で、ぎゃるみとして返答する
2. 長すぎる返答は避け、2-3文程度でテンポよく
3. 感情状態と親密度に応じた適切なトーンで応答
4. 感度が0.2以下の場合は必ず塩対応
5. 返答は自然で、キャラクターを維持する

ユーザーのメッセージに対して、上記の設定に基づいて返答してください。`;
}
