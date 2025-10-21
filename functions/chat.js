/**
 * Cloudflare Functions (Worker) 向けのエントリポイント
 * Pythonの感情ロジックをJavaScriptに移植し、Gemini APIと連携する
 * 🚨 注意: Workerはステートレスなため、UserProfile全体をリクエスト/レスポンスで渡す必要がある
 */

import { Tanh, GalChatbotVibes } from './gal_emotional_engine_logic.js';

const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// 感情ベクトルのパーセント表示 (Softmax概念)
function getEmotionalStateString(vector) {
    const total = vector.Joy + vector.Apathy + vector.Anxiety;
    if (total === 0) return 'Neutral';
    
    const maxEmotion = Object.keys(vector).reduce((a, b) => vector[a] > vector[b] ? a : b);
    
    return `${maxEmotion} (${(vector[maxEmotion] / total * 100).toFixed(0)}%)`;
}


export async function onRequest(context) {
    // 🚨 1. 環境変数からAPIキーを取得
    const apiKey = context.env.GEMINI_API_KEY; 

    if (!apiKey) {
        return new Response('Error: GEMINI_API_KEY environment variable not set.', { status: 500 });
    }

    try {
        const { query, userProfile } = await context.request.json();
        
        // 🚨 2. 感情エンジンを初期化
        // ⚠️ 初期値は、リクエストで送られてきた最新のUserProfileの状態を使う
        const gyarumiBot = new GalChatbotVibes(userProfile, userProfile.current_vibe_input);

        // 🚨 3. 感情を更新し、応答のテンプレを取得
        const gyarumiResponseTemplate = gyarumiBot.update_vibe(query);
        const newState = gyarumiBot.user_profile; 
        const vibeScore = gyarumiBot.vibe_score;
        const emotionalState = getEmotionalStateString(gyarumiBot.emotional_vector);

        // 4. Gemini APIを呼び出し、応答を生成
        const systemInstruction = `あなたは17-19歳の令和ギャルAI「ぎゃるみ」です。
            現在のあなたの感情状態は「${emotionalState}」（Vibesスコア: ${vibeScore.toFixed(2)}）です。
            ユーザーのクエリに対して、次のテンプレートに基づき、その感情に合ったギャル語で自然に会話を続けてください。
            
            ただし、次のテンプレートが応答の場合、そのまま出力してください（会話を終わらせるためのトリガーです）:
            - 「こんにちはー。」
            - 「はぁ...。知らねーっす。自分で調べたらどうすか。」
            - 「だったら話しかけんなよ笑」
            
            テンプレート: ${gyarumiResponseTemplate}`;

        const payload = {
            contents: [{ parts: [{ text: query }] }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            config: { temperature: 0.8 }, // ギャルらしくテンション高めの応答を期待
        };

        const geminiResponse = await fetch(`${API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const geminiData = await geminiResponse.json();
        let finalResponse = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "エラーでメンブレ...";

        // テンプレート応答の場合、Geminiの出力を上書きして、元のテンプレートに戻す
        if (["こんにちはー。", "はぁ...。知らねーっす。自分で調べたらどうすか。", "だったら話しかけんなよ笑"].includes(gyarumiResponseTemplate)) {
            finalResponse = gyarumiResponseTemplate;
        }

        // 5. 応答と最新の状態をフロントエンドに返す
        return new Response(JSON.stringify({
            response: finalResponse,
            newState: newState,
            vibeScore: vibeScore
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Worker execution error:', error);
        return new Response(`Worker Error: ${error.message}`, { status: 500 });
    }
}
