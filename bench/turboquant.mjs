import { TurboQuantEngine } from '../js/lib/turboquant.js';

export class TurboQuantSearch extends TurboQuantEngine {
  constructor(dim = 1024, qjlDim = 1024, seed = 42) {
    super(dim, qjlDim, seed);
  }

  index(toolsMap) {
    return this.fit(toolsMap);
  }
}

export { TurboQuantEngine };
