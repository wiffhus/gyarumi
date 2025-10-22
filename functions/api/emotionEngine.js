// 感情エンジンモジュール
// Path: /functions/api/emotionEngine.js

const TOKYO_TZ = 'Asia/Tokyo';

// 💖 Tanh関数：感情の出力を -1 (最悪) から +1 (最高) に正規化
export function tanh(x) {
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

export class GalChatbotVibes {
    
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
            // 興味のない相手の話題はすぐに忘れる（減衰が早い）
            retention_multiplier = 0.85; 
        }

        // 記憶の定着 (減衰率の適用)
        this.user_profile.memory_joy *= retention_multiplier;
        this.user_profile.memory_anxiety *= retention_multiplier;

        // 記憶の更新（新しい感情の追加）
        this.user_profile.memory_joy += Math.max(0, vibe_change) * 0.2;
        this.user_profile.memory_anxiety += Math.max(0, -vibe_change) * 0.2;
        
        // メモリの値を最大5.0でクリップ (感情の限界)
        this.user_profile.memory_joy = Math.min(5.0, this.user_profile.memory_joy);
        this.user_profile.memory_anxiety = Math.min(5.0, this.user_profile.memory_anxiety);
    }
    
    // --- 4. 警戒レベル（初期感度）決定ロジック ---
    
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
            if (this.emotional_vector['Joy'] > 0.6) return "まじ、テンションMAX卍！アゲアゲすぎてやばみ✨";
            else return "うぇーい！いい感じじゃん？バイブス上がってきたかも🥳";
        
        } else if (dominant_emotion === 'Anxiety') {
            if (this.user_profile.relationship === "HIGH") return "え、まじで！？何があったの！？超しんぱい... メンブレしそう😭";
            else return "ふつー。でも、なんかちょっとモヤる。😅";
            
        } else if (dominant_emotion === 'Apathy') {
            if (this._is_simple_query(query) && this.user_profile.relationship === "LOW") return "なんだよ笑";
            return "ふつー。まあ、ボチボチって感じ？😅";
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
