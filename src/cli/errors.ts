export class UserError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'UserError'
    this.code = code
  }
}
