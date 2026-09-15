export function SettingsTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString('zh-CN')}</time>
}
