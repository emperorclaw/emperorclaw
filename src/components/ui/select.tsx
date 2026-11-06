"use client"

import * as React from "react"
import { IconCheck, IconChevronDown } from "@tabler/icons-react"
import { Select as SelectPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * A drop-in replacement for the native `<select>`: same `value` / `onChange`
 * (`e.target.value`) contract and the same `<option>` / `<optgroup>` children,
 * rendered as a refined popup list (Radix Select) that grows from its trigger.
 */

/** The minimal event shape `onChange` receives, so `e.target.value` handlers keep working. */
export type SelectChangeEvent = {
  target: { value: string; name: string }
  currentTarget: { value: string; name: string }
}

type ParsedOption = { value: string; label: React.ReactNode; text: string; disabled: boolean }
type ParsedEntry =
  | ({ kind: "option" } & ParsedOption)
  | { kind: "group"; key: string; label: string; options: ParsedOption[] }

// Radix forbids "" as an item value; empty-string options map to this and back.
const EMPTY_VALUE = "__ec-select-empty__"
const toItemValue = (value: string) => (value === "" ? EMPTY_VALUE : value)
const fromItemValue = (value: string) => (value === EMPTY_VALUE ? "" : value)

function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return nodeText(node.props.children)
  return ""
}

type OptionProps = { value?: string | number; disabled?: boolean; children?: React.ReactNode }
type OptgroupProps = { label?: string; disabled?: boolean; children?: React.ReactNode }

function parseOption(props: OptionProps, groupDisabled = false): ParsedOption {
  const text = nodeText(props.children)
  return {
    value: props.value === undefined ? text : String(props.value),
    label: props.children,
    text,
    disabled: Boolean(props.disabled) || groupDisabled,
  }
}

function parseChildren(children: React.ReactNode, groupDisabled = false): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    if (child.type === React.Fragment) {
      entries.push(...parseChildren((child.props as { children?: React.ReactNode }).children, groupDisabled))
    } else if (child.type === "option") {
      entries.push({ kind: "option", ...parseOption(child.props as OptionProps, groupDisabled) })
    } else if (child.type === "optgroup") {
      const props = child.props as OptgroupProps
      const options = parseChildren(props.children, groupDisabled || Boolean(props.disabled)).flatMap((entry) =>
        entry.kind === "option" ? [entry] : entry.options
      )
      entries.push({ kind: "group", key: String(child.key ?? props.label ?? entries.length), label: props.label ?? "", options })
    }
  })
  return entries
}

const flatOptions = (entries: ParsedEntry[]) => entries.flatMap((entry) => (entry.kind === "option" ? [entry] : entry.options))

type SelectProps = Omit<
  React.ComponentProps<typeof SelectPrimitive.Trigger>,
  "value" | "defaultValue" | "onChange" | "children" | "dir"
> & {
  value?: string | number
  defaultValue?: string | number
  /** Native-style handler: receives `{ target: { value, name } }`. */
  onChange?: (event: SelectChangeEvent) => void
  onValueChange?: (value: string) => void
  /** Submits with a surrounding form under this name. */
  name?: string
  required?: boolean
  disabled?: boolean
  /** Shown when the value matches no option. */
  placeholder?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Extra classes for the popup list. */
  contentClassName?: string
  /** `<option>` / `<optgroup>` elements, exactly as for a native select. */
  children?: React.ReactNode
}

function Select({
  value,
  defaultValue,
  onChange,
  onValueChange,
  name,
  required,
  disabled,
  placeholder,
  open,
  onOpenChange,
  className,
  contentClassName,
  children,
  ref,
  ...triggerProps
}: SelectProps) {
  const entries = React.useMemo(() => parseChildren(children), [children])
  const options = flatOptions(entries)
  const isControlled = value !== undefined
  const [innerValue, setInnerValue] = React.useState(() =>
    defaultValue !== undefined ? String(defaultValue) : (options.find((option) => !option.disabled)?.value ?? "")
  )
  const current = isControlled ? String(value) : innerValue
  const hasMatch = options.some((option) => option.value === current)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  const setTriggerRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  const handleValueChange = (next: string) => {
    const nextValue = fromItemValue(next)
    if (!isControlled) setInnerValue(nextValue)
    onValueChange?.(nextValue)
    if (onChange) {
      const target = { value: nextValue, name: name ?? "" }
      onChange({ target, currentTarget: target })
    }
  }

  const renderItem = (option: ParsedOption) => (
    <SelectItem key={option.value} value={toItemValue(option.value)} disabled={option.disabled} textValue={option.text}>
      {option.label}
    </SelectItem>
  )

  return (
    <SelectPrimitive.Root
      value={hasMatch ? toItemValue(current) : ""}
      onValueChange={handleValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        ref={setTriggerRef}
        data-slot="select-trigger"
        data-no-press
        aria-required={required || undefined}
        className={cn(
          "inline-flex w-auto max-w-full min-w-0 cursor-default items-center justify-between gap-2 rounded-xl border border-border px-3 text-left text-sm text-foreground shadow-sm outline-none transition-[border-color,background-color,box-shadow] select-none",
          // Native selects sized by padding or an explicit height keep that size; the rest match the input height.
          !/(^|\s)(h|min-h|py)-/.test(className ?? "") && "h-10",
          // A caller's own background wins in both themes; otherwise the trigger reads like an input.
          !/(^|\s)bg-/.test(className ?? "") &&
            "bg-black/[0.02] hover:bg-black/[0.035] focus-visible:bg-black/[0.03] dark:bg-white/[0.035] dark:hover:bg-white/[0.05] dark:focus-visible:bg-white/[0.055]",
          "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/30",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground",
          className
        )}
        {...triggerProps}
      >
        {/* Every label sits in one grid cell (invisibly), so an auto-width trigger is as wide as its widest option, like a native select. */}
        <span className="grid min-w-0 flex-1">
          <span className="col-start-1 row-start-1 truncate">
            <SelectPrimitive.Value placeholder={placeholder} />
          </span>
          {options.map((option) => (
            <span key={option.value} aria-hidden className="invisible col-start-1 row-start-1 h-0 truncate">
              {option.text}
            </span>
          ))}
        </span>
        <SelectPrimitive.Icon asChild>
          <IconChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-slot="select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "ec-materialize relative z-[60] max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width) max-w-[calc(100vw-1.5rem)] origin-(--radix-select-content-transform-origin) overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-pop)",
            contentClassName
          )}
        >
          <SelectPrimitive.Viewport className="fade-y scroll-my-1 overscroll-contain p-1">
            {entries.map((entry, index) =>
              entry.kind === "option" ? (
                renderItem(entry)
              ) : (
                <SelectPrimitive.Group key={entry.key}>
                  {index > 0 && <SelectPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />}
                  {entry.label && (
                    <SelectPrimitive.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                      {entry.label}
                    </SelectPrimitive.Label>
                  )}
                  {entry.options.map(renderItem)}
                </SelectPrimitive.Group>
              )
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
      {/* A real select carries the value for native form submission and `required` validation; focus is handed to the trigger. */}
      {(name || required) && (
        <select
          aria-hidden
          tabIndex={-1}
          name={name}
          required={required}
          disabled={disabled}
          value={current}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          className="sr-only"
        >
          {!hasMatch && <option value={current} />}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.text}
            </option>
          ))}
        </select>
      )}
    </SelectPrimitive.Root>
  )
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-3 pl-8 text-sm outline-hidden select-none pointer-coarse:min-h-10",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <IconCheck className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </span>
    </SelectPrimitive.Item>
  )
}

export { Select }
