import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Card } from '@heroui/react'
import { cn } from 'tailwind-variants'

/**
 * 通用列表项：统一 HeroUI「卡片行」骨架（Card + Card.Content 两栏布局），
 * 供各配置面板（plugin / core / profile）与预装插件列表共用，
 * 避免到处重复写 `<Card className="rounded-md bg-panel2 py-3"><Card.Content />`。
 *
 * - left：行左侧主内容（min-w-0，允许截断）
 * - right：行右侧操作区（shrink-0，勾选框 / 按钮 / 状态 chip 等）
 * - footer：主行之后的附加内容（如 ui/config/core 的「本地核心更新」入口）
 * - onClick：传入则整行可点击并显示手型光标
 *
 * 其余 `div` 属性（`data-testid` / `data-*`）原样透传到根节点，供 E2E 定位与读状态。
 */
export interface ItemProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  left?: ReactNode
  right?: ReactNode
  footer?: ReactNode
}

export function Item({ left, right, footer, className, ...rest }: ItemProps) {
  return (
    <Card
      className={cn('rounded-md bg-panel2 py-3', rest.onClick && 'cursor-pointer', className)}
      {...rest}
    >
      <Card.Content className="flex flex-col gap-1.5">
        <div className="flex flex-row items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">{left}</div>
          <div className="flex shrink-0 items-center gap-1.5">{right}</div>
        </div>
        {footer}
      </Card.Content>
    </Card>
  )
}
