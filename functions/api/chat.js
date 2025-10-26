// Cloudflare Worker Function for Gyarumi Chat API
// Path: /functions/api/chat.js
// + 日常写真コンテキスト記憶機能 + プリクラ機能追加

// ============================================
// APIキーローテーション機能 (変更なし)
// ============================================
function getRotatedAPIKey(context) { /* ... (省略) ... */ }
function getImageAPIKey(context) { /* ... (省略) ... */ }
// ============================================
// シンプル化された機嫌エンジン (変更なし)
// ============================================
const TOKYO_TZ = 'Asia/Tokyo';
function tanh(x) { /* ... (省略) ... */ }
class UserProfile { /* ... (省略) ... */ }
class SimpleMoodEngine { /* ... (省略、_is_asking_about_photo も含む) ... */ }
// ============================================
// Cloudflare Worker エントリーポイント
// ============================================

const corsHeaders = { /* ... (省略) ... */ };

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

        // ★★★ 写真コンテキスト処理 (変更なし) ★★★
        if (moodEngine.last_photo_context && moodEngine._is_asking_about_photo(userMessage)) {
            console.log('User is asking about the last photo context:', moodEngine.last_photo_context);
            const contextInfo = moodEngine.last_photo_context;
            let contextDescription = contextInfo.isPurikura ? "友達と撮ったプリクラ" : `「${contextInfo.activity}」の時の写真`; // ★プリクラ用説明追加
            if (contextInfo.place && !contextInfo.isPurikura) { contextDescription += ` 場所は「${contextInfo.place.name}」`; }

            const photoContextPrompt = `【状況】\nあなたは直前にユーザーに日常の写真を送りました。\nその写真は「${contextDescription}」という状況のものです。\n\nユーザーがその写真について「${userMessage}」と質問しています。\n\n【指示】\n1. あなたが覚えている写真の状況 (${contextDescription}) を踏まえ、ユーザーの質問に自然に答えてください。\n2. ギャルっぽい口調で、友達に話すように。\n3. 場所の情報 (${contextInfo.place ? contextInfo.place.name + ', URL: ' + contextInfo.place.url : 'なし'}) も必要なら自然に含めてください。(プリクラの場合は場所情報は不要)\n4. 2-3文程度で簡潔に。\n\n例 (ユーザー「これどこ？」・プリクラでない場合):\n「あ、これね！${contextInfo.place ? contextInfo.place.name + 'だよ〜！まじ映えスポット✨' : 'えっと、これは確か〜'}」\n例 (ユーザー「誰と撮ったの？」・プリクラの場合):\n「これは仲良いことプリ撮ったときのやつ〜！まじ盛れたっしょ✌️」\n\nでは、返答してください：`;

            response = await callGeminiAPI( getRotatedAPIKey(context), photoContextPrompt, conversationHistory, moodEngine, moodStyle, false, false, timeContext, false, userProfile );
            moodEngine.last_photo_context = null; // ★コンテキストクリア
            console.log('Cleared last_photo_context');

        } else {
             // ★★★ 通常の処理フロー ★★★
            if (moodEngine.last_photo_context) {
                console.log('User did not ask about the photo, clearing last_photo_context');
                moodEngine.last_photo_context = null; // ★コンテキストクリア
            }

            const isGenericQuery = moodEngine._is_generic_query(userMessage);
            const needsRealtimeSearch = moodEngine._needs_realtime_search(userMessage);
            const isAskingDailyLife = moodEngine._is_asking_about_daily_life(userMessage);
            const isAskingAboutPlace = moodEngine._is_asking_about_place(userMessage);
            const isAskingLimitedTime = moodEngine._is_asking_about_limited_time(userMessage);

            if (isAskingLimitedTime) { /* ... (省略 - 変更なし) ... */ }
            else if (isAskingAboutPlace && moodEngine.last_mentioned_place) { /* ... (省略 - 変更なし) ... */ }
            else {
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

                // ★新規: プリクラチャンス判定 (日常写真生成が決まった場合のみ)
                let isPurikura = false;
                if (shouldGenerateDailyPhoto) {
                    const purikuraChance = 0.15; // 15%の確率でプリクラ
                    if (Math.random() < purikuraChance) {
                        isPurikura = true;
                        console.log('*** Purikura Time! ***');
                    }
                }

                if (isDrawing && userMessage.trim()) { /* ... (省略 - お絵描き処理 変更なし) ... */ }
                else {
                    // 日常写真を生成する場合 (プリクラ含む)
                    if (shouldGenerateDailyPhoto) {
                        try {
                            console.log(`Generating daily life photo... ${isPurikura ? '(Purikura Mode)' : ''}`);
                            const imageApiKey = getImageAPIKey(context);
                            const gyarumiFaceImage = await loadGyarumiFaceImage();
                            const timeReference = moodEngine._extract_time_reference(userMessage);
                            
                            let activityResponse = '';
                            let realPlace = null;
                            let photoContextActivity = ''; // ★コンテキスト保存用

                            // ★プリクラの場合、活動内容と場所は固定
                            if (isPurikura) {
                                activityResponse = "友達とプリクラ撮ってきた！"; // プリクラ用の活動説明
                                realPlace = null; // 場所は特定しない
                                photoContextActivity = activityResponse; // コンテキストも固定
                            } else {
                                // プリクラでない場合：通常の活動決定プロセス
                                const isRightNow = timeReference === 'right_now';
                                let activityPrompt = '';
                                if (isRightNow) { activityPrompt = `ユーザーが「${userMessage}」と聞いています。あなた（ぎゃるみ）は**今まさに**何をしていますか？\n現在時刻: ${timeContext.timeString}（${timeContext.hour}時頃）\n以下から1つ選ぶか、時刻から一般的な高校生ギャルの状況を創作し、現在進行形で1文で答えて：\n選択肢：カフェでまったり, 買い物中, ご飯食べてる, 公園でのんびり, 家でゴロゴロ, ネイルサロンにいる, 友達と遊んでる, 学校にいる, 勉強してる\n例：「今ね〜、カフェでまったりしてるよ〜！」`; }
                                else { activityPrompt = `ユーザーが「${userMessage}」と聞いています。あなた（ぎゃるみ）は今日または最近何をしていましたか？以下から1つ選ぶか創作し、1文で簡潔に答えて：\n選択肢：カフェに行った, ショッピングに行った, レストランでご飯を食べた, 公園で遊んだ, 家でのんびりした\n例：「今日ね〜、原宿のカフェ行ってきた！」`; }
                                
                                activityResponse = await callGeminiAPI( getRotatedAPIKey(context), activityPrompt, [], moodEngine, moodStyle, false, false, timeContext, false, userProfile );
                                console.log('Activity decided:', activityResponse);
                                photoContextActivity = activityResponse; // コンテキスト用に保存

                                // 場所検索 (必要な場合)
                                if (activityResponse && (activityResponse.includes('カフェ') || activityResponse.includes('レストラン') || activityResponse.includes('ショッピング'))) {
                                    console.log('Searching for real place...');
                                    realPlace = await searchRealPlace(activityResponse, context);
                                    console.log('Real place found:', realPlace);
                                }
                            }

                            // 活動記録と場所情報を保存 (プリクラの場合は activityResponse だけ記録)
                            const today = new Date().toISOString().split('T')[0];
                            const activityKey = `${today}_${timeReference || 'unknown'}`; // timeReference がない場合も考慮
                            moodEngine.daily_activities[activityKey] = { activity: activityResponse, timestamp: Date.now(), place: realPlace };
                            if (realPlace) { moodEngine.last_mentioned_place = realPlace; }

                            // ★★★ 写真コンテキストを保存 (プリクラ情報も含む) ★★★
                            moodEngine.last_photo_context = {
                                activity: photoContextActivity,
                                place: realPlace,
                                isPurikura: isPurikura // ★プリクラかどうか
                            };
                            console.log('Saved photo context:', moodEngine.last_photo_context);

                            // 写真プロンプトを作成 (★プリクラフラグを渡す)
                            const photoPrompt = createDailyPhotoPrompt(activityResponse, timeContext, moodStyle, isPurikura);

                            // 写真を生成
                            generatedImageBase64 = await generateImage(photoPrompt, imageApiKey, gyarumiFaceImage);
                            console.log('Daily photo generated:', generatedImageBase64 ? 'SUCCESS' : 'FAILED');

                            // 定型文で応答
                            const quickResponses = isPurikura
                                ? ["プリ撮った！まじ盛れたっしょ✨", "友達とプリ〜！見てみて💕", "じゃん！プリクラ！✌️"] // プリクラ用
                                : ["じゃーん、みてみて！✨", "写真撮ったよ〜！", "これどう？いい感じっしょ？💕", "はい、おまたせ〜！", "こんな感じだったよ！", "撮ってみた！"]; // 通常用
                            
                            if (generatedImageBase64) {
                                response = quickResponses[Math.floor(Math.random() * quickResponses.length)];
                            } else {
                                console.warn('Photo generation failed, returning activity text only');
                                response = activityResponse; // 写真失敗時は活動内容を返す
                                moodEngine.last_photo_context = null; // ★コンテキストクリア
                            }

                        } catch (dailyPhotoError) {
                            console.error('Error during daily photo generation process:', dailyPhotoError);
                            response = await callGeminiAPI( getRotatedAPIKey(context), userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData );
                            generatedImageBase64 = null;
                            moodEngine.last_photo_context = null; // ★コンテキストクリア
                        }
                    } else {
                        // 通常のテキスト応答
                        response = await callGeminiAPI( getRotatedAPIKey(context), userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData );
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
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    } catch (error) {
        console.error('Error:', error);
        return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
}

// ============================================
// 画像生成関数など
// ============================================

// searchRealPlace, searchLimitedTimeInfo, loadGyarumiFaceImage は変更なし
// ... (省略) ...

// 日常写真のプロンプトを生成 (★ isPurikura 引数追加)
function createDailyPhotoPrompt(gyarumiResponse, timeContext, moodStyle, isPurikura = false) {
    const detailedCharacterDescription = `
DETAILED CHARACTER DESCRIPTION (based on reference image):
Basic Information: Japanese female, age 17-19, Real person appearance (not anime/illustration), Youth-emotional, naughty cat-like face.
Face & Features: Large brown eyes, defined eyeliner, pink eyeshadow tones, bright smile showing teeth, fair complexion, small delicate features, East Asian cat-like structure.
Hair: Long below chest, Pastel color gradient (Pink/mint green streaks), Straight blunt bangs (hime-cut).
Fashion Style (Harajuku/Jirai-kei/Yume-kawaii with K-POP influence): Pastel palette, Layered outfits, accessories, Trendy Japanese street fashion + K-POP idol aesthetics, Varying outfit details (CRITICAL: avoid exact same outfit).
Overall Aesthetic: Kawaii, colorful, Instagram-worthy, energetic, Modern Japanese gyaru/gal + K-POP trends.`;

    // ★プリクラの場合、設定を上書き
    if (isPurikura) {
        return createPurikuraPrompt(detailedCharacterDescription, timeContext);
    }

    // --- 以下、プリクラでない場合の通常ロジック (家モード含む) ---
    let activity = ''; let location = ''; let photoType = 'selfie'; let includesFriend = Math.random() < 0.3; let isHomeRelaxMode = false;

    if (/カフェ|コーヒー|飲み物|スタバ|cafe/i.test(gyarumiResponse)) { activity = 'at a trendy cafe'; location = 'a stylish modern cafe'; photoType = Math.random() < 0.5 ? 'selfie' : 'drink_photo'; }
    else if (/公園|散歩|outside|外/i.test(gyarumiResponse)) { activity = 'at a park'; location = 'a beautiful park'; photoType = 'selfie'; }
    else if (/ショッピング|買い物|服|shop/i.test(gyarumiResponse)) { activity = 'shopping'; location = 'a trendy shopping area'; photoType = Math.random() < 0.6 ? 'selfie' : 'outfit_photo'; }
    else if (/ランチ|ご飯|食事|レストラン/i.test(gyarumiResponse)) { activity = 'having a meal'; location = 'a cute restaurant'; photoType = Math.random() < 0.4 ? 'selfie' : 'food_photo'; }
    else if (/海|ビーチ|beach/i.test(gyarumiResponse)) { activity = 'at the beach'; location = 'a beautiful beach'; photoType = 'selfie'; }
    else if (/家|部屋|room|ごろごろ|ゴロゴロ/i.test(gyarumiResponse)) { activity = 'relaxing at home'; location = 'a cute bedroom/living room'; photoType = 'selfie'; isHomeRelaxMode = true; }
    else { activity = 'in the city'; location = 'a trendy urban street'; photoType = 'selfie'; }

    const month = timeContext.month; const isIndoor = /home|bedroom|room|cafe|restaurant/i.test(location); let seasonalElements = '';
    // ... (季節感ロジック省略) ...
    if (isIndoor) { if (month >= 3 && month <= 5) seasonalElements = 'Spring light.'; else if (month >= 6 && month <= 8) seasonalElements = 'Summer light.'; else if (month >= 9 && month <= 11) seasonalElements = 'Autumn light.'; else seasonalElements = 'Winter light.'; }
    else { if (month >= 3 && month <= 5) seasonalElements = 'Spring, cherry blossoms/greenery.'; else if (month >= 6 && month <= 8) seasonalElements = 'Summer, bright sun, blue sky.'; else if (month >= 9 && month <= 11) seasonalElements = 'Autumn, colorful foliage.'; else seasonalElements = 'Winter, cool clear weather.'; }

    const friendDescription = (includesFriend && photoType === 'selfie' && !isHomeRelaxMode) ? '\n- Her friend (another young Japanese girl) is also in the selfie, happy.' : '';
    const photoStyle = `CRITICAL: REALISTIC PHOTOGRAPH, not illustration. Smartphone camera, Natural daylight, High quality but natural, Instagram aesthetic, Real textures, Photorealistic.`;
    let appearanceOverrides = "";
    if (isHomeRelaxMode && photoType === 'selfie') { appearanceOverrides = `\nAppearance adjustments for home relax mode:\n- Makeup: Natural, minimal, almost no-makeup look.\n- Hair: Casual, slightly messy (loose bun, ponytail, or down but relaxed). Still pastel color.\n- Glasses: (Optional 50% chance) Wearing cute prescription glasses.\n- Expression: Relaxed, soft smile or neutral.`; }

    let specificPrompt = '';
    if (photoType === 'selfie') { specificPrompt = `REFERENCE IMAGE PROVIDED: Use as exact face template.\n${detailedCharacterDescription}${appearanceOverrides}\nSELFIE photo (自撮り):\nCRITICAL SELFIE RULES: FROM GIRL'S PERSPECTIVE, Slightly above eye level angle, Looking DIRECTLY AT CAMERA, Only face(s)/upper body visible, Background is ${location}, Close-up/medium shot${friendDescription}\nCRITICAL CONSISTENCY: Face MUST match reference (adjust makeup if home mode). Hair pastel pink/mint green (style varies if home mode). Outfit matches ${activity} (pastel K-POP gyaru aesthetic, ${isHomeRelaxMode ? 'loungewear/pajamas' : 'street fashion'}). Expression: ${isHomeRelaxMode ? 'Relaxed' : 'Cheerful'}.\nLocation: ${activity} in ${location}\n${seasonalElements}\nOutfit: Appropriate for ${activity}, pastel K-POP gyaru, varied details.`; }
    else if (photoType === 'drink_photo') { specificPrompt = `Photo of a DRINK:\nClose-up stylish drink, Held or on table, Aesthetic cafe background (blurred), If hands visible: Pastel manicure, cute rings/bracelets, delicate feminine hands (17-19), Instagram style, Kawaii.\nLocation: ${location}\n${seasonalElements}`; }
    else if (photoType === 'food_photo') { specificPrompt = `Photo of FOOD:\nOverhead/angled shot, Delicious looking, aesthetic plating, Restaurant/cafe, If hands/chopsticks visible: Pastel manicure, cute rings/bracelets, delicate feminine hands (17-19), Instagram style, Kawaii.\nLocation: ${location}\n${seasonalElements}`; }
    else if (photoType === 'outfit_photo') { specificPrompt = `REFERENCE IMAGE PROVIDED: Use as exact face template.\n${detailedCharacterDescription}\nOUTFIT photo:\nFull-body or 3/4 shot, Mirror selfie OR friend taking photo, Shopping area/fitting room background, Focus on K-POP gyaru style.\nCRITICAL CONSISTENCY: Face MUST match reference. Hair pastel pink/mint green. Full outfit trendy K-POP inspired Japanese gyaru street fashion, Pastel kawaii.\nLocation: ${location}\n${seasonalElements}\nOutfit: Full coordination, pastel K-POP gyaru, varied details.`; }

    return `A realistic photograph: ${specificPrompt}\n${photoStyle}\nScene details: Natural candid moment, Casual composition.\nFINAL CRITICAL REMINDERS: Photorealistic, NOT illustration/anime. Real textures, lighting, features. FICTIONAL CHARACTER (AI mascot), 17-19, Japanese. Face MUST match reference (adjust makeup if home). Hair: Pastel pink/mint green. Style: Kawaii K-POP influenced Japanese gyaru. Safe content.`;
}

// ★新規: プリクラ用プロンプト生成関数
function createPurikuraPrompt(detailedCharacterDescription, timeContext) {
    const photoStyle = `
CRITICAL STYLE: This image should look like a Japanese PURIKURA photo booth picture (print or digital scan).
- BRIGHT, slightly washed-out lighting typical of Purikura booths.
- HEAVY skin smoothing filter effect, flawless complexion (but still photorealistic faces).
- (Subtle) eye enlargement effect might be present.
- OVERLAYS: Cute digital decorations MUST be overlaid on the photo:
    - Sparkles ✨, hearts 💕, stars ⭐, cute animal stamps (e.g., bunny ears).
    - Handwritten-style text (ENGLISH ONLY, e.g., "BFF", "LOVE", "DATE", "KAWAII", simple date like "10.26"). Use cute fonts. Keep text minimal.
    - Colorful borders or backgrounds might be part of the Purikura machine's design.
- Composition: Close-up or medium shot of two girls.
- Overall Aesthetic: Extremely KAWAII, playful, energetic, decorated.
- The people should look photorealistic, but the final image includes heavy digital editing and overlays characteristic of Purikura.
`;

    const specificPrompt = `
REFERENCE IMAGE PROVIDED: Use the reference image as the exact face template for the MAIN girl (Gyarumi).

${detailedCharacterDescription} {/* Gyarumi's description */}

This is a PURIKURA photo:
- Setting: Inside a brightly lit Japanese Purikura photo booth. The background might show the booth's interior or a digital pattern chosen in the booth.
- People: TWO young Japanese girls (age 17-19):
    1. Gyarumi: Her face MUST exactly match the reference image. Maintain pastel pink/mint green hair. Fashion according to K-POP gyaru style described above.
    2. Her Friend: Another fashionable Japanese girl with a similar gyaru/K-POP style. Different hair color/style from Gyarumi (e.g., blonde, brown, different pastel shade). Equally cute and stylish. Her face does NOT need to match the reference.
- Pose: Posing close together, looking happy and playful at the camera. Typical Purikura poses like peace signs (✌️), forming a heart with hands, cheek-to-cheek, cute pouts, winks etc.
- Expression: Big smiles, excited, having fun.

CRITICAL CONSISTENCY REQUIREMENTS (Gyarumi):
- Gyarumi's face MUST exactly match the reference image (with Purikura filter effects applied).
- Maintain EXACT facial features from reference.
- Hair MUST keep the pastel pink/mint green color scheme.
- Outfit: Trendy K-POP inspired Japanese gyaru street fashion, suitable for going out with friends. Vary details from previous images.

Friend's Appearance:
- Also dressed in trendy K-POP gyaru style.
- Different appearance from Gyarumi but equally fashionable.

Season/Time: Assume current time (${timeContext.dateString}) unless specified otherwise. Outfit should be appropriate.
`;

    return `A realistic photograph styled as a Japanese Purikura print/scan: ${specificPrompt}\n${photoStyle}\nFINAL CRITICAL REMINDERS: Purikura style with heavy filters and OVERLAYS (sparkles, text, stamps). TWO girls. Gyarumi MUST match reference. K-POP Gyaru fashion. Photorealistic faces under the filter. Safe content. ENGLISH text only on overlays.`;
}


// createImageGenerationPrompt は 前回の修正版のまま (変更なし)
function createImageGenerationPrompt(userPrompt, moodStyle) { /* ... (省略) ... */ }

// generateImage は変更なし
async function generateImage(prompt, apiKey, referenceImageBase64 = null) { /* ... (省略) ... */ }

// callGeminiAPI は変更なし
async function callGeminiAPI(apiKey, userMessage, conversationHistory, moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage, userProfile, imageData = null) { /* ... (省略) ... */ }

// createSimpleGyarumiPrompt は変更なし
function createSimpleGyarumiPrompt(moodEngine, moodStyle, isGenericQuery, needsRealtimeSearch, timeContext, hasImage = false, userProfile = {}) { /* ... (省略) ... */ }
