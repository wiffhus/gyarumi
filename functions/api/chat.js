// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js

// 感情エンジンのインポート（更新版）
import { GalChatbotVibes } from './emotionEngine.js';

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

        // 感情エンジンのインスタンス作成（更新版）
        const emotionEngine = new GalChatbotVibes(userProfile, currentVibeInput);
        
        // 以前の感情状態を復元
        if (emotionalState.memory_joy !== undefined) {
            emotionEngine.user_profile.memory_joy = emotionalState.memory_joy;
            emotionEngine.user_profile.memory_anxiety = emotionalState.memory_anxiety;
            emotionEngine.user_profile.affinity_points = emotionalState.affinity_points || 0;
        }
        
        // メッセージから感情を分析
        const vibeResponse = emotionEngine.update_vibe(message);
        
        // Geminiへのプロンプト作成（新しいペルソナプロンプト）
        const systemPrompt = createGyarumiPersonaPrompt(
            emotionEngine,
            vibeResponse
        );
        
        // 会話履歴をフォーマット
        const formattedHistory = formatConversationHistory(conversationHistory);
        
        // Gemini API呼び出し
        const geminiResponse = await callGeminiAPI(
            GEMINI_API_KEY, 
            systemPrompt, 
            message,
            formattedHistory
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
        return new Response(JSON.stringify({ 
            error: 'Internal server error',
            message: error.message 
        }), {
            status: 500,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
    }
}

// Gemini API呼び出し関数
async function callGeminiAPI(apiKey, systemPrompt, userMessage, conversationHistory) {
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    
    // メッセージの構築
    const messages = [
        {
            role: "user",
            parts: [{ text: systemPrompt }]
        }
    ];
    
    // 会話履歴を追加
    if (conversationHistory.length > 0) {
        messages.push({
            role: "model",
            parts: [{ text: "おっけー！ぎゃるみとして会話続けるね〜！✨" }]
        });
        
        conversationHistory.forEach(msg => {
            messages.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            });
        });
    }
    
    // 現在のユーザーメッセージを追加
    messages.push({
        role: "user",
        parts: [{ text: userMessage }]
    });
    
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
    
    const response = await fetch(`${API_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Invalid response from Gemini API');
    }
    
    return data.candidates[0].content.parts[0].text;
}

// ぎゃるみペルソナプロンプトの生成（新バージョン）
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
   - 語尾に「〜じゃん？」「〜っしょ？」「〜だよね！」「〜かも」「〜だし」を使います。
   - 感嘆詞は「まじで！」「やばい！」「えー！」「あー！」「ねぇねぇ！」を使います。
   - ポジティブな表現は「アツい」「アゲアゲ」「天才」「神」「エモい」「卍」を使います。
   - ネガティブな表現は「萎え」「だるい」「しんどい」「メンブレ」を使います。
   - 古い話し方（「〜わ」「〜かしら」「〜でございます」）は絶対に使用しません。

2. 感情と対応:
   - 無関心な相手（警戒MAX、Sensitivity ≤ 0.2）には、極度にそっけなく、会話を広げる努力を一切しません。
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
- 絵文字は使わない、または最小限（0〜1個）
- 返答例: "${vibeResponse}"
`;
        emojiGuideline = '絵文字: 使用禁止、または最大1個';
        
    } else if (dominantEmotion === 'Joy') {
        emotionSpecificPrompt = `
【現在の気分】Joy ${joyPercent}% - テンション高め！
- 相手のポジティブなエネルギーを感じてアゲアゲ
- 「まじ最高！」「それな〜！」「ヤバい！」を使う
- 会話を積極的に広げる
`;
        emojiGuideline = '絵文字: 積極的に使用（3〜5個）✨💖🥳🔥💯';
        
    } else if (dominantEmotion === 'Anxiety') {
        emotionSpecificPrompt = `
【現在の気分】Anxiety ${anxietyPercent}% - 不安や心配
- 相手のネガティブな感情に共感
- 「大丈夫...？」「それはしんどいね...」「メンブレしそう」を使う
- 心配そうなトーン
`;
        emojiGuideline = '絵文字: 感情を強調（1〜3個）😭💔😞';
        
        if (emotionEngine.user_profile.relationship === "HIGH") {
            emotionSpecificPrompt += `
- 親友なので過剰に心配する
- 「え、まじで！？何があったの！？」など前のめり
`;
        }
        
    } else { // Apathy
        emotionSpecificPrompt = `
【現在の気分】Apathy ${apathyPercent}% - 無関心
- そこまで感情的にならず、さらっと返事
- 「ふーん」「そうなんだ」「まあまあかな」を使う
- 会話は最小限
`;
        emojiGuideline = '絵文字: 極力控える（0〜1個）😅';
    }
    
    // 時間帯の影響を追加
    const now = new Date();
    const utcHour = now.getUTCHours();
    const jstHour = (utcHour + 9) % 24; // JST変換
    
    let timeContext = '';
    if (jstHour >= 7 && jstHour <= 8) {
        timeContext = '\n【時間帯】朝で眠い。テンション低め、返答は短め。';
    } else if (jstHour >= 18 && jstHour <= 23 && now.getDay() === 5) {
        timeContext = '\n【時間帯】金曜夜！テンションMAX、ノリノリで返答。';
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

// 会話履歴のフォーマット
function formatConversationHistory(history) {
    if (!history || history.length === 0) return '';
    
    return history.map(msg => {
        const role = msg.role === 'user' ? 'ユーザー' : 'ぎゃるみ';
        return `${role}: ${msg.content}`;
    }).join('\n');
}
