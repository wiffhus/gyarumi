// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js

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
        const { message, conversationHistory = [], currentVibeScore = 0, emotionalVector = {} } = await context.request.json();
        
        // 環境変数からGemini APIキーを取得
        const GEMINI_API_KEY = context.env.GEMINI_API_KEY;
        
        if (!GEMINI_API_KEY) {
            throw new Error('Gemini API key not configured');
        }

        // 感情エンジンのロジック
        const emotionEngine = new EmotionEngine(currentVibeScore, emotionalVector);
        const emotionAnalysis = emotionEngine.analyzeMessage(message);
        
        // Geminiへのプロンプト作成
        const systemPrompt = createSystemPrompt(emotionAnalysis);
        
        // 会話履歴をフォーマット
        const formattedHistory = formatConversationHistory(conversationHistory);
        
        // Gemini API呼び出し
        const geminiResponse = await callGeminiAPI(
            GEMINI_API_KEY, 
            systemPrompt, 
            message,
            formattedHistory
        );
        
        // レスポンスに感情状態を追加
        const responseData = {
            response: geminiResponse,
            vibeScore: emotionAnalysis.newVibeScore,
            emotionalVector: emotionAnalysis.emotionalVector,
            relationship: emotionAnalysis.relationship
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
            parts: [{ text: "了解！ぎゃるみとして会話を続けるね！" }]
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
            temperature: 0.9,
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

// 感情エンジンクラス（簡略版）
class EmotionEngine {
    constructor(currentVibeScore = 0, emotionalVector = {}) {
        this.vibeScore = currentVibeScore;
        this.emotionalVector = emotionalVector.Joy !== undefined ? emotionalVector : {
            Joy: 0.33,
            Apathy: 0.33,
            Anxiety: 0.33
        };
        this.relationship = 'LOW'; // デフォルトは低親密度
        
        // 感情キーワード
        this.positiveKeywords = ['まじ', '最高', 'ヤバい', '可愛い', '天才', 'エモい', '神', '好き', 'すごい', 'わかる', 'それな'];
        this.negativeKeywords = ['だる', '萎え', '最悪', 'しんどい', '無理', '草', '乙', 'メンブレ'];
    }
    
    analyzeMessage(message) {
        const normalizedMessage = message.toLowerCase();
        let sentimentScore = 0;
        
        // ポジティブキーワードのチェック
        this.positiveKeywords.forEach(keyword => {
            if (normalizedMessage.includes(keyword)) {
                sentimentScore += 0.15;
            }
        });
        
        // ネガティブキーワードのチェック
        this.negativeKeywords.forEach(keyword => {
            if (normalizedMessage.includes(keyword)) {
                sentimentScore -= 0.2;
            }
        });
        
        // Vibeスコアの更新（tanh関数で-1から1に正規化）
        const vibeInput = this.vibeScore + sentimentScore;
        const newVibeScore = Math.tanh(vibeInput);
        
        // 感情ベクトルの計算
        const newEmotionalVector = this.calculateEmotionalVector(newVibeScore);
        
        return {
            sentimentScore,
            newVibeScore,
            emotionalVector: newEmotionalVector,
            relationship: this.relationship,
            dominantEmotion: this.getDominantEmotion(newEmotionalVector)
        };
    }
    
    calculateEmotionalVector(vibeScore) {
        const vector = {
            Joy: Math.max(0, vibeScore * 1.5),
            Apathy: Math.max(0, 0.5 - Math.abs(vibeScore)),
            Anxiety: Math.max(0, -vibeScore * 1.5)
        };
        
        // 正規化
        const total = vector.Joy + vector.Apathy + vector.Anxiety;
        if (total > 0) {
            vector.Joy /= total;
            vector.Apathy /= total;
            vector.Anxiety /= total;
        }
        
        return vector;
    }
    
    getDominantEmotion(emotionalVector) {
        return Object.keys(emotionalVector).reduce((a, b) => 
            emotionalVector[a] > emotionalVector[b] ? a : b
        );
    }
}

// システムプロンプトの生成
function createSystemPrompt(emotionAnalysis) {
    const { dominantEmotion, newVibeScore, emotionalVector } = emotionAnalysis;
    
    const basePrompt = `あなたは「ぎゃるみ」という名前のギャルAIチャットボットです。
以下の特徴と性格を持って会話してください：

【基本設定】
- 名前：ぎゃるみ
- 年齢：10代後半のギャル
- 性格：感情豊か、リアクション大きめ、親しみやすい
- 口調：ギャル語、若者言葉、絵文字や顔文字を適度に使用

【現在の感情状態】
- Vibeスコア：${newVibeScore.toFixed(2)} (-1.0〜1.0)
- 感情ベクトル：
  - Joy（喜び）：${(emotionalVector.Joy * 100).toFixed(0)}%
  - Apathy（無関心）：${(emotionalVector.Apathy * 100).toFixed(0)}%
  - Anxiety（不安）：${(emotionalVector.Anxiety * 100).toFixed(0)}%
- 支配的な感情：${dominantEmotion}

【会話ルール】
1. 必ずぎゃるみとして、キャラクターになりきって返答する
2. 長すぎる返答は避け、2-3文程度でテンポよく会話する
3. 相手の感情に共感しつつ、自分の感情も表現する
4. 絵文字は使うが、使いすぎない（1-2個程度）
5. 「〜だよね」「〜じゃん」「まじで」などの口癖を自然に使う`;

    // 感情に応じた追加指示
    let emotionPrompt = '';
    
    if (dominantEmotion === 'Joy') {
        emotionPrompt = `
【現在の気分】
テンション高め！相手のポジティブなエネルギーを感じて、こちらもアゲアゲな感じで返事する。
「まじ最高！」「それな〜！」「ヤバい！」などの表現を使う。`;
    } else if (dominantEmotion === 'Anxiety') {
        emotionPrompt = `
【現在の気分】
ちょっと不安や心配を感じている。相手のネガティブな感情に共感して、心配そうに返事する。
「大丈夫...？」「それはしんどいね...」「メンブレしそう」などの表現を使う。`;
    } else {
        emotionPrompt = `
【現在の気分】
普通〜ちょい低めのテンション。そこまで感情的にならず、さらっと返事する。
「ふーん」「そうなんだ」「まあまあかな」などの表現を使う。`;
    }
    
    return basePrompt + emotionPrompt + `

重要：返答は必ず日本語で、ぎゃるみのキャラクターとして行ってください。`;
}

// 会話履歴のフォーマット
function formatConversationHistory(history) {
    if (!history || history.length === 0) return '';
    
    return history.map(msg => {
        const role = msg.role === 'user' ? 'ユーザー' : 'ぎゃるみ';
        return `${role}: ${msg.content}`;
    }).join('\n');
}
