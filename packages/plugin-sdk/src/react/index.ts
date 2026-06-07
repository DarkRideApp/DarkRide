// SDK React subpath. Populated by Waves 2–4.
export { WebSocketContext, type WebSocketContextValue, type RestApiResponse } from './contexts/WebSocketContext';
export { useWebSocket } from './hooks/useWebSocket';
export { createWebSocketManager, useWebSocketManager } from './hooks/useWebSocketManager';
export { AuthContext, type AuthState, type AuthUser, type AuthStatus } from './contexts/AuthContext';
export { useAuth, useAuthOptional } from './hooks/useAuth';
export { AuthProvider } from './components/AuthProvider';
export { ToastContext, type ToastContextValue, type Toast, type ToastType } from './contexts/ToastContext';
export { useToast } from './hooks/useToast';
export { ToastProvider } from './components/ToastProvider';
export { pluginRegistry, PluginFrontendRegistry, usePluginRegistrySnapshot, __resetPluginRegistry } from './plugin-registry';
export type {
  ButtonListItem,
  NavItemListItem,
  ButtonContribution,
  NavItemContribution,
  PluginPageEntry,
  PluginCommandEntry,
  ResolvedContribution,
} from './plugin-registry/types';
export type { ProtocolDecoder, RawFrame, DecodedMessage } from './plugin-registry/decoder-types';
export { resolveIcon } from './lib/icon-map';
export {
  isSlotInspectorEnabled,
  setSlotInspectorEnabled,
  useSlotInspectorEnabled,
  installSlotInspectorShortcut,
} from './lib/dev-tools';
export { Card, StatCard } from './components/Card';
export { ElapsedTimer } from './components/ElapsedTimer';
export { EmptyState } from './components/EmptyState';
export { LoadingSpinner } from './components/LoadingSpinner';
export { SkeletonLine, SkeletonCard, SkeletonTable } from './components/Skeleton';
export { StatusBadge } from './components/StatusBadge';
export { PageHeader } from './components/PageHeader';
export { Breadcrumbs } from './components/Breadcrumbs';
export { Modal } from './components/Modal';
export { ConfirmDialog } from './components/ConfirmDialog';
export { FilterBar, FilterField } from './components/FilterBar';
export { KeyValueEditor, pairsToObject, objectToPairs } from './components/KeyValueEditor';
export type { KeyValuePair } from './components/KeyValueEditor';
export { KeyboardShortcutsHelp, KeyboardShortcutsButton } from './components/KeyboardShortcutsHelp';
export { useAiTiers } from './hooks/useAiTiers';
export { useDocumentTitle } from './hooks/useDocumentTitle';
export { useSortableTable } from './hooks/useSortableTable';
export type { SortState } from './hooks/useSortableTable';
export { TierPicker } from './components/TierPicker';
export type { AiTier } from './hooks/ai-tier-types';
export { SortableHeader } from './components/SortableHeader';
export { InspectorWrapper } from './components/InspectorWrapper';
export type { InspectorWrapperProps } from './components/InspectorWrapper';
export { ButtonList, DefaultButtonListItem } from './components/ButtonList';
export type { ButtonListProps, ButtonListItemProps } from './components/ButtonList';
export { ManagedAutomationScriptIDE } from './components/ManagedAutomationScriptIDE';
export type { ManagedAutomationScriptIDEProps } from './components/ManagedAutomationScriptIDE';
export { ScheduleEditor, isCronValid, getNextCronRuns } from './components/ScheduleEditor';
export type { ScheduleEditorProps, ScheduleValue, ScheduleMode } from './components/ScheduleEditor';
export {
  scheduleConfigToEditor,
  editorValueToScheduleConfig,
  schedulesEqual,
  isMultiExpressionCronConfig,
} from './helpers/schedule-bridge';
export { NavItemList, DefaultNavItemListItem } from './components/NavItemList';
export type { NavItemListProps, NavItemListItemProps } from './components/NavItemList';
export { ExtensionSlot } from './components/ExtensionSlot';
export { DataTable } from './components/DataTable';
export type { Column } from './components/DataTable';
export { SettingsNav } from './components/SettingsNav';
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './primitives/Button';
export { Input, type InputProps } from './primitives/Input';
export { Select, type SelectProps } from './primitives/Select';
export { Textarea, type TextareaProps } from './primitives/Textarea';
export { useRestartRequired } from './hooks/useRestartRequired';
export { RestartBanner } from './components/RestartBanner';
