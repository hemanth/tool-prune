export interface JSONSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: Array<string | number | boolean>;
  properties?: Record<string, JSONSchemaProperty>;
  items?: JSONSchemaProperty;
  [key: string]: any;
}

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  [key: string]: any;
}

export interface ToolDefinition {
  name?: string;
  id?: string;
  title?: string;
  domain?: string;
  description?: string;
  summary?: string;
  criteria?: string;
  parameters?: JSONSchema;
  inputSchema?: JSONSchema;
  input_schema?: JSONSchema;
  schema?: JSONSchema;
  type?: 'function' | string;
  function?: {
    name: string;
    description?: string;
    parameters?: JSONSchema;
    [key: string]: any;
  };
  [key: string]: any;
}

export type ToolInput =
  | Record<string, string | Partial<ToolDefinition>>
  | ToolDefinition[];

export interface CustomDecisionChoiceResult {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  [key: string]: any;
}

export interface CustomDecisionEngine {
  name?: string;
  choice(params: {
    state: any;
    question: string;
    options: Record<string, string>;
  }): Promise<CustomDecisionChoiceResult> | CustomDecisionChoiceResult;
}

export type CustomEngineFn = (
  query: any,
  criteria: Record<string, string>,
  options?: Partial<ToolPruneOptions>
) => Promise<CustomDecisionChoiceResult | CandidateTool[]> | CustomDecisionChoiceResult | CandidateTool[];

export interface ToolPruneOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  instructions?: string;
  engine?: 'typesafe' | 'turboquant' | 'turboquant-wasm' | CustomDecisionEngine | CustomEngineFn;
  threshold?: number;
  topK?: number | 'auto';
  k?: number | 'auto';
  auto?: boolean;
  minK?: number;
  maxK?: number;
  minScore?: number;
  minProbability?: number;
  minProb?: number;
  relativeThreshold?: number;
  cliffRatio?: number;
  dominantMargin?: number;
  allowEmpty?: boolean;
}

export interface CandidateTool<T = any> {
  name: string;
  probability: number;
  score?: number;
  tool?: T;
}

export interface SelectionResult<T = any> {
  tool: string;
  confidence: number;
  probability: number;
  topK: CandidateTool<T>[];
  autoSelected: CandidateTool<T>[];
  autoTools: T[];
  requiresGeneration: number;
  latency: number;
  engine?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  raw?: any;
}

export function normalizeTools(tools: ToolInput): {
  criteria: Record<string, string>;
  registry: Map<string, any>;
};

export function autoSelectCandidates<T = any>(
  candidates: CandidateTool<T>[],
  options?: Partial<ToolPruneOptions>
): CandidateTool<T>[];

export class TurboQuantEngine {
  dim: number;
  qjlDim: number;
  constructor(dim?: number, qjlDim?: number, seed?: number);
  embedText(text: string): Float32Array;
  fit(tools: Record<string, any> | Map<string, any>): void;
  search(query: string, topK?: number): Array<{ name: string; probability: number; score: number }>;
}

export class ToolPruner<T = any> {
  criteria: Record<string, string>;
  registry: Map<string, T>;
  constructor(tools: ToolInput, options?: ToolPruneOptions);
  getEngine(options?: Partial<ToolPruneOptions>): ToolPruneOptions['engine'];
  select(query: string | Record<string, any>, options?: Partial<ToolPruneOptions>): Promise<SelectionResult<T>>;
  filter(query: string | Record<string, any>, options?: Partial<ToolPruneOptions>): Promise<T[]>;
  auto(query: string | Record<string, any>, options?: Partial<ToolPruneOptions>): Promise<T[]>;
  dispatch<R = any>(
    query: string | Record<string, any>,
    handlers: Record<string, (query: any, selection: SelectionResult<T>) => Promise<R> | R>,
    options?: Partial<ToolPruneOptions>
  ): Promise<R | SelectionResult<T>>;
}

export interface ToolPruneFn {
  <T = any>(query: string, tools: T[], options?: ToolPruneOptions): Promise<SelectionResult<T>>;
  (query: string, tools: ToolInput, options?: ToolPruneOptions): Promise<SelectionResult>;
  <T = any>(tools: T[], options?: ToolPruneOptions): ToolPruner<T>;
  (tools: ToolInput, options?: ToolPruneOptions): ToolPruner;
  auto<T = any>(query: string, tools: T[], options?: ToolPruneOptions): Promise<T[]>;
  auto(query: string, tools: ToolInput, options?: ToolPruneOptions): Promise<any[]>;
  ToolPruner: typeof ToolPruner;
  TurboQuantEngine: typeof TurboQuantEngine;
  normalizeTools: typeof normalizeTools;
  autoSelectCandidates: typeof autoSelectCandidates;
}

declare const toolPrune: ToolPruneFn;
export { toolPrune };
export default toolPrune;
