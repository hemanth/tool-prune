export interface ToolDefinition {
  name: string;
  description?: string;
  criteria?: string;
  [key: string]: any;
}

export type ToolInput =
  | Record<string, string | Partial<ToolDefinition>>
  | ToolDefinition[];

export interface ToolPruneOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  threshold?: number;
  topK?: number;
}

export interface CandidateTool {
  name: string;
  probability: number;
  tool?: any;
}

export interface SelectionResult {
  tool: string;
  confidence: number;
  probability: number;
  topK: CandidateTool[];
  requiresGeneration: number;
  latency: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  raw?: any;
}

export class ToolPruner {
  constructor(tools: ToolInput, options?: ToolPruneOptions);
  select(query: string | Record<string, any>, options?: Partial<ToolPruneOptions>): Promise<SelectionResult>;
  filter(query: string | Record<string, any>, options?: { k?: number } & Partial<ToolPruneOptions>): Promise<any[]>;
  dispatch<T = any>(
    query: string | Record<string, any>,
    handlers: Record<string, (query: any, selection: SelectionResult) => Promise<T> | T>,
    options?: Partial<ToolPruneOptions>
  ): Promise<T | SelectionResult>;
}

export default function toolPrune(query: string, tools: ToolInput, options?: ToolPruneOptions): Promise<SelectionResult>;
export default function toolPrune(tools: ToolInput, options?: ToolPruneOptions): ToolPruner;

