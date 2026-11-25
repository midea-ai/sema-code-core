import { tryLockHistory } from '../../src/util/historyStore'

const fs = require('node:fs') as typeof import('node:fs')
const guard = process.argv[2] + '.lock.reclaim'
const unlink = fs.unlinkSync
fs.unlinkSync = file => {
  if (file === guard && process.argv[3] === 'before') process.exit(38)
  unlink(file)
  if (file === guard && process.argv[3] === 'after') process.exit(38)
}
tryLockHistory(process.argv[2])
