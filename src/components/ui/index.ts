// The shared UI kit (specification §15). Pages use the kit; they do not restyle basic controls.
// Server-safe components have no directive; Dialog, NavTabs, RelativeTime, and SubmitButton are client components.
export { cn, controlBase, controlHeight } from "./cn";
export { Icon, SourceTypeIcon, ICONS, SOURCE_TYPE_ICONS, type IconName, type IconProps } from "./Icon";
export {
  Button,
  LinkButton,
  buttonClass,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type LinkButtonProps,
} from "./Button";
export { SubmitButton } from "./SubmitButton";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Chip, ChipLink, ChipToggle, type ChipLinkProps, type ChipProps, type ChipToggleProps } from "./Chip";
export { Card, SectionHeader, type CardProps } from "./Card";
export { PageContainer, PageHeader, type PageContainerProps, type PageHeaderProps } from "./Page";
export { Field, FieldGroup, fieldDescribedBy, type FieldProps } from "./Field";
export {
  Input,
  Textarea,
  Select,
  type InputProps,
  type SelectOption,
  type SelectProps,
  type TextareaProps,
} from "./Input";
export { Switch, type SwitchProps } from "./Switch";
export { SegmentedControl, type SegmentOption, type SegmentedControlProps } from "./SegmentedControl";
export { NavTabs, type NavTabItem, type NavTabsProps } from "./NavTabs";
export { pathMatches } from "./paths";
export { Dialog, type DialogProps } from "./Dialog";
export { Disclosure, type DisclosureProps } from "./Disclosure";
export { Banner, type BannerProps, type BannerTone } from "./Banner";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Table, THead, TBody, Tr, Th, Td, type TableProps } from "./Table";
export { RelativeTime, type RelativeTimeProps } from "./RelativeTime";
export { formatAbsolute, formatAbsoluteUtc, formatClock, formatDateUtc, formatRelative } from "./time-format";
export { Meter, type MeterProps } from "./Meter";
export { Spinner, type SpinnerProps } from "./Spinner";
export { SavedNote, type SavedNoteProps } from "./SavedNote";
