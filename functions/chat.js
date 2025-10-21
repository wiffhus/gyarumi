/**
 * Cloudflare Pages FunctionでGoogle Gemini APIを叩くためのエンドポイントです。
 *
 * 🚨 最終修正: 400 Bad Requestエラーを回避するため、リクエストボディの構造と
 * Gemini APIへのペイロード形式（特にcontentsとsystemInstruction）を再確認し、
 * APIが要求する正しい形式でデータを送信します。
 */

// Gemini APIのURLとモデル名
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';
const API_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

// CORSヘッダーを定義
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*', // すべてのオリジンからのアクセスを許可
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', // Content-Typeのみ許可
};

/**
 * Cloudflare Pages Functionのエントリポイント
 * @param {Request} request
 * @param {object} env - Cloudflare環境変数 (env.GEMINI_API_KEY)
 * @returns {Response}
 */
export async function onRequest({ request, env }) {
    // OPTIONSメソッド（プリフライトリクエスト）の対応
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: CORS_HEADERS,
            status: 204 // No Content
        });
    }

    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // 1. APIキーの確認を強化
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey || apiKey.length < 10) {
        console.error('ERROR: GEMINI_API_KEY is not configured or is too short.');
        return new Response(
            JSON.stringify({ 
                error: 'APIキー設定エラー',
                response: 'ごめん... Cloudflare側のAPIキー設定（GEMINI_API_KEY）がうまくいってないかも... マジだるいから、オーナーに確認してって！🥹' 
            }), 
            { 
                status: 500, 
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
            }
        );
    }

    try {
        // 🚨 修正: クライアントから history という名前で来ているので、そのまま history で受け取る
        const { history } = await request.json(); 

        // 2. ギャルみのシステムプロンプトを設定
        const systemInstruction = {
            parts: [{ text: GYARUMI_SYSTEM_PROMPT }]
        };

        // 3. APIリクエストのペイロード構築
        const payload = {
            // 🚨 修正: history の中身をそのまま contents に割り当てる（クライアント側の履歴は正しい形式）
            contents: history, 
            config: {
                systemInstruction: systemInstruction,
            },
            generationConfig: {
                temperature: 0.8, 
            },
        };

        // 4. Gemini APIへのフェッチリクエスト
        // 🚨 認証方式: APIキーをクエリパラメータとして渡す (成功例に合わせる)
        const fetchUrl = `${API_BASE_URL}?key=${apiKey}`;

        const response = await fetch(fetchUrl, { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const headers = { 'Content-Type': 'application/json', ...CORS_HEADERS };

        if (!response.ok) {
            const errorBody = await response.text();
            console.error('Gemini API 4xx/5xx Error. Response Body:', errorBody);
            
            let errorDetail = 'APIからの返答が変だったんだよね...';
            try {
                const errorJson = JSON.parse(errorBody);
                errorDetail = errorJson.error?.message || errorDetail;
            } catch (e) {
                // JSONでなかった場合はそのまま
            }

            return new Response(
                JSON.stringify({ 
                    error: `Gemini API call failed with status ${response.status}`, 
                    response: `ごめん... ぎゃるみがGemini APIに弾かれたよ... 🥹 (ステータス: ${response.status}, 詳細: ${errorDetail.substring(0, 50)}...)` 
                }), 
                { status: response.status, headers }
            );
        }

        const result = await response.json();
        
        // 5. 応答からテキストを抽出
        // 🚨 履歴を systemInstruction で分離したため、role: 'model' が返ってくるはず
        const generatedText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!generatedText) {
             console.error('ERROR: Generated text is empty.', result);
             return new Response(JSON.stringify({ response: 'ごめん... ぎゃるみ、言葉が出てこなかったよ...🥹' }), {
                status: 500,
                headers
            });
        }

        // 6. クライアントにテキストを返す
        return new Response(JSON.stringify({ response: generatedText }), { headers });

    } catch (e) {
        console.error('Request processing error (JSON parsing/Fetch issue):', e);
        return new Response(JSON.stringify({ response: 'マジ通信エラー！ネットワークがだるいっしょ！' }), { status: 500, headers: CORS_HEADERS });
    }
}
