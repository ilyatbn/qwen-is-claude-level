// One map per file so vitest runs the six in parallel workers — see backdrop-real.suite.ts.
import { backdropRealSuite } from './backdrop-real.suite'

backdropRealSuite('v1 small/777')
