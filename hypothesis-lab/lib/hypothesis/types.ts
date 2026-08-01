/** Shapes of scripts/hypothesis/run.py output (lib/hypothesis/results.json). */

export type Verdict = "supported" | "weak" | "rejected" | "inconclusive";
export type Agreement = "agree" | "partial" | "disagree" | "unverified";

export interface HypothesisCase {
  date: string;
  label: string;
  returnPct: number;
  hit: boolean;
  priceBefore?: number;
  priceAfter?: number;
}

export interface CategoryBar {
  label: string;
  avgReturnPct: number;
  n: number;
  upRate: number;
}

export interface HypothesisStats {
  n: number;
  hits: number;
  hitRate: number | null;
  baselineRate: number | null;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  pValue: number;
  verdict: Verdict;
  extra?: Record<string, number>;
}

export interface AiOpinion {
  model: string;
  verdict: Verdict;
  confidence: "high" | "medium" | "low";
  commentary_ko: string;
}

export interface Hypothesis {
  id: string;
  question: string;
  questionEn: string;
  category: "macro" | "price" | "seasonality";
  method: string;
  stats: HypothesisStats;
  cases: HypothesisCase[];
  chart: { type: "eventBars" | "categoryBars"; data?: CategoryBar[]; unit?: string; note?: string };
  ai: { claude: AiOpinion | null; openai: AiOpinion | null; agreement: Agreement };
}

export interface HypothesisResults {
  generatedAt: string;
  dataset: {
    coin: string;
    start: string;
    end: string;
    days: number;
    nativeInterval: string;
    sourceFiles: string[];
    sample?: boolean;
  };
  baseline: { upDayProb: number; avgDailyRetPct: number; dailyVolPct: number };
  hypotheses: Hypothesis[];
}
