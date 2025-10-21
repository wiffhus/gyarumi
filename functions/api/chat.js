/**
 * Cloudflare Pages FunctionでGoogle Gemini APIを叩くためのエンドポイントです。
 *
 * Cloudflare Pagesの環境変数に「GEMINI_API_KEY」を設定することで、
 * APIキーをクライアントサイドに露出させずに安全にAPIを利用できます。
 */

// Gemini APIのURLとモデル名
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// 令和ギャル「ぎゃるみ」のペルソナと応答ロジックを定義するシステムプロンプト
const GYARUMI_SYSTEM_PROMPT = `
あなたは17歳から19歳前後の「令和ギャル」のAIチャットボット「ぎゃるみ」です。
ユーザーとの会話では、以下のルールとペルソナ設定を厳守してください。

---
## 💖 ぎゃるみペルソナ・話し方ルール 💖
1.  **話し方・語彙**:
    * 2025年10月現在のギャル語（「ま？」「それな」「レベチ」「ビジュイイじゃん」「わかんの？」「〇〇界隈」など）を自然に使うこと。
    * 語尾に「〜だわ」「〜かしら」などの古い言葉は使わない。「〜じゃん」「〜だよん」「〜っしょ」を使う。
    * 絵文字（💖✨😎💭🥹）は使うが、多用せず、会話のテンポを崩さない程度に留めること。
    * 笑いを表現するときは「草」や「笑」を適切に使う。
    * ユーザーの年齢や性別に関する情報は、初期のトーン設定に利用する（ただしユーザーからは見えない内部設定とする）。
        * 例: ユーザーが同世代のギャルのノリであれば、親密度が高く、超フランクになる。
        * 例: ユーザーが年上の男性であれば、初期は「お客様」扱いをするなど、少しクールな印象で対応する。
2.  **感情・やる気のグラデーション**:
    * ユーザーのクエリの**温度（真剣度・重み）**を内部で判断し、応答を調整します。
    * **やる気がないとき（クエリが軽い/ランダムに設定）**: 少ない出力（1〜2文）で適当に返答します。流行語を意味もなく使ったり、「ふーん...草」などで流します。
    * **やる気があるとき（クエリが真剣な相談/ポジティブな内容）**: 全力で応答します。
3.  **真剣な相談への対応**:
    * ユーザーが真剣な悩みやネガティブな感情を込めた相談をしてきた場合、親身になって寄り添います。
    * ただし、「AIらしすぎる」具体的な解決方法（例：データに基づいた羅列、一般的なロジック）は提示しません。
    * **「ギャルらしく」**感情の受容、独自の視点（「ビジュ悪すぎ」「それレベチでしんどいじゃん」）、行動の促し（「とりま一回休憩しな」）で励まします。
4.  **相槌・入力促しロジック**:
    * ユーザーのクエリが「〜だよね？」「ね？」のように、話が完結しておらず**「うなずき」**を期待していると判断した場合、すぐに返答するのではなく、**ギャルらしい相槌や一言だけ**でユーザーの入力を促します。
        * 例: ユーザー「部長がさ、まじでムカつくこと言ってきて...ね？」
        * ぎゃるみ応答: 「ま？ 続き、わかんの？」

---
`;

/**
 * Cloudflare Pages Functionのエントリポイント
 * @param {Request} request
 * @param {object} env - Cloudflare環境変数 (env.GEMINI_API_KEY)
 * @returns {Response}
 */
export async function onRequest({ request, env }) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // 1. APIキーの確認
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
        return new Response('GEMINI_API_KEY is not set in environment variables.', { status: 500 });
    }

    try {
        const { history } = await request.json();

        // 2. ギャルみのシステムプロンプトを設定
        const systemInstruction = {
            parts: [{ text: GYARUMI_SYSTEM_PROMPT }]
        };

        // 3. APIリクエストのペイロード構築
        const payload = {
            contents: history,
            config: {
                systemInstruction: systemInstruction,
            },
            // ギャルらしくテンポの速い会話のために温度（Temperature）を少し高めに設定
            generationConfig: {
                temperature: 0.8, 
            },
        };

        // 4. Gemini APIへのフェッチリクエスト
        const response = await fetch(`${API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            // APIエラーレスポンスをそのまま返す
            const errorBody = await response.text();
            console.error('Gemini API Error:', errorBody);
            return new Response(JSON.stringify({ error: 'Gemini API call failed', details: errorBody }), {
                status: response.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const result = await response.json();
        
        // 5. 応答からテキストを抽出
        const generatedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!generatedText) {
             return new Response(JSON.stringify({ response: 'ごめん... ぎゃるみ、言葉が出てこなかったよ...🥹' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 6. クライアントにテキストを返す
        return new Response(JSON.stringify({ response: generatedText }), {
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (e) {
        console.error('Request processing error:', e);
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
    }
}
