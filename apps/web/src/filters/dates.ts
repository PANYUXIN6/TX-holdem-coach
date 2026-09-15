export function localDateBoundary(value: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请输入有效日期')
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    throw new Error('请输入有效日期')
  if (end) date.setDate(date.getDate() + 1)
  return date.toISOString().replace('.000Z', '.000000Z')
}
export function localDateInput(value: string | null, end = false) {
  if (!value) return ''
  const date = new Date(value)
  if (end) date.setDate(date.getDate() - 1)
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}
