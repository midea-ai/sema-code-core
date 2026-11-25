import { HistoryStore, __historyTestHooks } from '../../src/util/historyStore'

const store = new HistoryStore(process.argv[2], process.argv[3] ?? 'process-exit')
store.load()
__historyTestHooks.afterStep = step => { if (step === 'rewrite:messages') process.exit(37) }
store.save({ messages: [{ type: 'user', uuid: 'replacement' as any, message: { role: 'user', content: 'replacement' } }], todos: [] }, true)
