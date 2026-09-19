/**
 * CollapsibleCard — a Card whose body can be collapsed with the small chevron
 * in the header. The header row (title, icon, header actions) always stays
 * visible so each section keeps its label and any live status badges; only the
 * body collapses. Implements the disclosure pattern: the toggle exposes
 * aria-expanded / aria-controls, and collapsed content is removed from the DOM
 * so it is neither focusable nor announced to screen readers.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'

export function CollapsibleCard({
  title,
  icon,
  actions,
  defaultOpen = true,
  children,
}: {
  title: string
  icon?: ReactNode
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const regionId = useId()
  return (
    <Card>
      <CardHeader className="flex-wrap">
        <CardTitle className="flex items-center gap-2">
          {icon}
          <span>{title}</span>
        </CardTitle>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={regionId}
            aria-label={open ? `Hide ${title}` : `Show ${title}`}
            className="btn-lift flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border/70 bg-secondary/40 text-muted-foreground transition-colors duration-150 hover:border-border hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn('h-4 w-4 transition-transform duration-200 ease-out', !open && '-rotate-90')}
            />
          </button>
        </div>
      </CardHeader>
      {open && (
        <div id={regionId} role="region" aria-label={`${title} section`}>
          <CardContent>{children}</CardContent>
        </div>
      )}
    </Card>
  )
}