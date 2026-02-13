/**
 * 用户中断操作异常
 * 当用户主动中断操作时抛出此异常，区别于系统错误
 */
export class InterruptedException extends Error {
  constructor(message = 'Operation was interrupted by user') {
    super(message)
    this.name = 'InterruptedException'
  }
}

/**
 * 检查中断信号并抛出中断异常
 * @param abortController 中断控制器
 */
export function checkAbortSignal(abortController: AbortController): void {
  if (abortController.signal.aborted) {
    throw new InterruptedException()
  }
}

/**
 * 判断是否为中断异常
 * @param error 错误对象
 */
export function isInterruptedException(error: unknown): error is InterruptedException {
  return error instanceof InterruptedException
}