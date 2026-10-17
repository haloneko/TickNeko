/**
 * 归属筛选：Owner[] → SelectMenu 选项，四页共用。
 * 复杂度 O(n²)，n = 归属数；每档一次 find，人数级可忽略。
 * 档位：全部 → extraOptions → 各归属。不足两档默认不渲染，renderAlways 覆盖（日志页按 isAdmin）。
 */
import type { Owner } from '../lib/ownersApi'
import SelectMenu from './SelectMenu'

/** 归属显示名：昵称 → 登录账号 → id（后端只保证 id 有值，昵称可能空） */
export function ownerName(ownerId: string, owners: Owner[]): string {
  const owner = owners.find((item) => item.owner_id === ownerId)
  if (!owner) return ownerId
  return owner.nickname || owner.account || ownerId
}

interface OwnerFilterProps {
  owners: Owner[]
  /** 选中归属 id；= allValue 即全部 */
  value: string
  onChange: (ownerId: string) => void
  /** 全部档 value，默认空串 */
  allValue?: string
  /** 全部档文案，默认「全部」 */
  allLabel?: string
  /** 额外档，排在全部之后、各归属之前（如「仅公共日志」） */
  extraOptions?: Array<{ value: string; label: string }>
  /** true 跳过「不足两档不渲染」 */
  renderAlways?: boolean
  /** horizontal 字段名在左（默认）/ vertical 在上 */
  layout?: 'horizontal' | 'vertical'
}

export default function OwnerFilter({
  owners,
  value,
  onChange,
  allValue = '',
  allLabel = '全部',
  extraOptions = [],
  renderAlways = false,
  layout = 'horizontal',
}: OwnerFilterProps) {
  if (!renderAlways && owners.length < 2) return null

  const options = [
    { value: allValue, label: allLabel },
    ...extraOptions,
    ...owners.map((owner) => ({
      value: owner.owner_id,
      label: ownerName(owner.owner_id, owners),
    })),
  ]

  return (
    <SelectMenu
      label="归属"
      layout={layout}
      options={options}
      value={value}
      onChange={onChange}
    />
  )
}
