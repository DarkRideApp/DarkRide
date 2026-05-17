import { DemoCard } from './sdk-catalog/DemoCard';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';

import ButtonDemo from './sdk-catalog/demos/Button';
import buttonSrc from './sdk-catalog/demos/Button.tsx?raw';

import InputDemo from './sdk-catalog/demos/Input';
import inputSrc from './sdk-catalog/demos/Input.tsx?raw';

import SelectDemo from './sdk-catalog/demos/Select';
import selectSrc from './sdk-catalog/demos/Select.tsx?raw';

import TextareaDemo from './sdk-catalog/demos/Textarea';
import textareaSrc from './sdk-catalog/demos/Textarea.tsx?raw';

import PageHeaderDemo from './sdk-catalog/demos/PageHeader';
import pageHeaderSrc from './sdk-catalog/demos/PageHeader.tsx?raw';

import BreadcrumbsDemo from './sdk-catalog/demos/Breadcrumbs';
import breadcrumbsSrc from './sdk-catalog/demos/Breadcrumbs.tsx?raw';

import CardDemo from './sdk-catalog/demos/Card';
import cardSrc from './sdk-catalog/demos/Card.tsx?raw';

import StatusBadgeDemo from './sdk-catalog/demos/StatusBadge';
import statusBadgeSrc from './sdk-catalog/demos/StatusBadge.tsx?raw';

import LoadingSpinnerDemo from './sdk-catalog/demos/LoadingSpinner';
import loadingSpinnerSrc from './sdk-catalog/demos/LoadingSpinner.tsx?raw';

import SkeletonDemo from './sdk-catalog/demos/Skeleton';
import skeletonSrc from './sdk-catalog/demos/Skeleton.tsx?raw';

import EmptyStateDemo from './sdk-catalog/demos/EmptyState';
import emptyStateSrc from './sdk-catalog/demos/EmptyState.tsx?raw';

import ElapsedTimerDemo from './sdk-catalog/demos/ElapsedTimer';
import elapsedTimerSrc from './sdk-catalog/demos/ElapsedTimer.tsx?raw';

import FilterBarDemo from './sdk-catalog/demos/FilterBar';
import filterBarSrc from './sdk-catalog/demos/FilterBar.tsx?raw';

import DataTableDemo from './sdk-catalog/demos/DataTable';
import dataTableSrc from './sdk-catalog/demos/DataTable.tsx?raw';

import SortableHeaderDemo from './sdk-catalog/demos/SortableHeader';
import sortableHeaderSrc from './sdk-catalog/demos/SortableHeader.tsx?raw';

import ButtonListDemo from './sdk-catalog/demos/ButtonList';
import buttonListSrc from './sdk-catalog/demos/ButtonList.tsx?raw';

import NavItemListDemo from './sdk-catalog/demos/NavItemList';
import navItemListSrc from './sdk-catalog/demos/NavItemList.tsx?raw';

import KeyValueEditorDemo from './sdk-catalog/demos/KeyValueEditor';
import keyValueEditorSrc from './sdk-catalog/demos/KeyValueEditor.tsx?raw';

import TierPickerDemo from './sdk-catalog/demos/TierPicker';
import tierPickerSrc from './sdk-catalog/demos/TierPicker.tsx?raw';

import InspectorWrapperDemo from './sdk-catalog/demos/InspectorWrapper';
import inspectorWrapperSrc from './sdk-catalog/demos/InspectorWrapper.tsx?raw';

import ModalDemo from './sdk-catalog/demos/Modal';
import modalSrc from './sdk-catalog/demos/Modal.tsx?raw';

import ConfirmDialogDemo from './sdk-catalog/demos/ConfirmDialog';
import confirmDialogSrc from './sdk-catalog/demos/ConfirmDialog.tsx?raw';

import KeyboardShortcutsHelpDemo from './sdk-catalog/demos/KeyboardShortcutsHelp';
import keyboardShortcutsHelpSrc from './sdk-catalog/demos/KeyboardShortcutsHelp.tsx?raw';

import ExtensionSlotDemo from './sdk-catalog/demos/ExtensionSlot';
import extensionSlotSrc from './sdk-catalog/demos/ExtensionSlot.tsx?raw';

import SettingsNavDemo from './sdk-catalog/demos/SettingsNav';
import settingsNavSrc from './sdk-catalog/demos/SettingsNav.tsx?raw';

import React from 'react';

const SECTION_STYLE: React.CSSProperties = { marginTop: '2.5rem' };
const DESC_STYLE: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: 14, marginTop: '0.25rem' };

export function SdkCatalog() {
  return (
    <div className="catalog-page" style={{ padding: '2rem', maxWidth: 1200 }}>
      <PageHeader
        title="SDK Catalog"
        subtitle="Visual smoke-test surface for every primitive in @darkrideapp/plugin-sdk/react"
      />

      {/* ── Button ─────────────────────────────────────────────────────── */}
      <section data-testid="catalog-button" style={SECTION_STYLE}>
        <h2>Button</h2>
        <p style={DESC_STYLE}>Atomic button primitive with variant + size props.</p>
        <DemoCard code={buttonSrc}><ButtonDemo /></DemoCard>
      </section>

      {/* ── Input ──────────────────────────────────────────────────────── */}
      <section data-testid="catalog-input" style={SECTION_STYLE}>
        <h2>Input</h2>
        <p style={DESC_STYLE}>Text input with invalid state and various types.</p>
        <DemoCard code={inputSrc}><InputDemo /></DemoCard>
      </section>

      {/* ── Select ─────────────────────────────────────────────────────── */}
      <section data-testid="catalog-select" style={SECTION_STYLE}>
        <h2>Select</h2>
        <p style={DESC_STYLE}>Dropdown select with default and invalid state.</p>
        <DemoCard code={selectSrc}><SelectDemo /></DemoCard>
      </section>

      {/* ── Textarea ───────────────────────────────────────────────────── */}
      <section data-testid="catalog-textarea" style={SECTION_STYLE}>
        <h2>Textarea</h2>
        <p style={DESC_STYLE}>Multi-line text input with invalid state and size variants.</p>
        <DemoCard code={textareaSrc}><TextareaDemo /></DemoCard>
      </section>

      {/* ── PageHeader ─────────────────────────────────────────────────── */}
      <section data-testid="catalog-page-header" style={SECTION_STYLE}>
        <h2>PageHeader</h2>
        <p style={DESC_STYLE}>Page title bar with optional subtitle and action slot.</p>
        <DemoCard code={pageHeaderSrc}><PageHeaderDemo /></DemoCard>
      </section>

      {/* ── Breadcrumbs ────────────────────────────────────────────────── */}
      <section data-testid="catalog-breadcrumbs" style={SECTION_STYLE}>
        <h2>Breadcrumbs</h2>
        <p style={DESC_STYLE}>Navigation breadcrumb trail.</p>
        <DemoCard code={breadcrumbsSrc}><BreadcrumbsDemo /></DemoCard>
      </section>

      {/* ── Card ───────────────────────────────────────────────────────── */}
      <section data-testid="catalog-card" style={SECTION_STYLE}>
        <h2>Card</h2>
        <p style={DESC_STYLE}>Surface container. StatCard adds a numeric metric display.</p>
        <DemoCard code={cardSrc}><CardDemo /></DemoCard>
      </section>

      {/* ── StatusBadge ────────────────────────────────────────────────── */}
      <section data-testid="catalog-status-badge" style={SECTION_STYLE}>
        <h2>StatusBadge</h2>
        <p style={DESC_STYLE}>All status variants: online, offline, running, success, failed, error, warning, cancelled, rooted.</p>
        <DemoCard code={statusBadgeSrc}><StatusBadgeDemo /></DemoCard>
      </section>

      {/* ── LoadingSpinner ─────────────────────────────────────────────── */}
      <section data-testid="catalog-loading-spinner" style={SECTION_STYLE}>
        <h2>LoadingSpinner</h2>
        <p style={DESC_STYLE}>Inline and large (centered) spinner variants.</p>
        <DemoCard code={loadingSpinnerSrc}><LoadingSpinnerDemo /></DemoCard>
      </section>

      {/* ── Skeleton ───────────────────────────────────────────────────── */}
      <section data-testid="catalog-skeleton" style={SECTION_STYLE}>
        <h2>Skeleton</h2>
        <p style={DESC_STYLE}>Loading placeholders: Line, Card, Table variants.</p>
        <DemoCard code={skeletonSrc}><SkeletonDemo /></DemoCard>
      </section>

      {/* ── EmptyState ─────────────────────────────────────────────────── */}
      <section data-testid="catalog-empty-state" style={SECTION_STYLE}>
        <h2>EmptyState</h2>
        <p style={DESC_STYLE}>Zero-data placeholder with title and description.</p>
        <DemoCard code={emptyStateSrc}><EmptyStateDemo /></DemoCard>
      </section>

      {/* ── ElapsedTimer ───────────────────────────────────────────────── */}
      <section data-testid="catalog-elapsed-timer" style={SECTION_STYLE}>
        <h2>ElapsedTimer</h2>
        <p style={DESC_STYLE}>Live elapsed-time display that ticks every second.</p>
        <DemoCard code={elapsedTimerSrc}><ElapsedTimerDemo /></DemoCard>
      </section>

      {/* ── FilterBar ──────────────────────────────────────────────────── */}
      <section data-testid="catalog-filter-bar" style={SECTION_STYLE}>
        <h2>FilterBar</h2>
        <p style={DESC_STYLE}>Horizontal toolbar for filter controls. FilterField wraps a labeled input.</p>
        <DemoCard code={filterBarSrc}><FilterBarDemo /></DemoCard>
      </section>

      {/* ── DataTable ──────────────────────────────────────────────────── */}
      <section data-testid="catalog-data-table" style={SECTION_STYLE}>
        <h2>DataTable</h2>
        <p style={DESC_STYLE}>Sortable, density-switchable table with optional bulk actions.</p>
        <DemoCard code={dataTableSrc}><DataTableDemo /></DemoCard>
      </section>

      {/* ── SortableHeader ─────────────────────────────────────────────── */}
      <section data-testid="catalog-sortable-header" style={SECTION_STYLE}>
        <h2>SortableHeader</h2>
        <p style={DESC_STYLE}>Click-to-sort &lt;th&gt; replacement. Pairs with useSortableTable.</p>
        <DemoCard code={sortableHeaderSrc}><SortableHeaderDemo /></DemoCard>
      </section>

      {/* ── ButtonList ─────────────────────────────────────────────────── */}
      <section data-testid="catalog-button-list" style={SECTION_STYLE}>
        <h2>ButtonList</h2>
        <p style={DESC_STYLE}>Renders a list of ButtonListItem objects with plugin injection support.</p>
        <DemoCard code={buttonListSrc}><ButtonListDemo /></DemoCard>
      </section>

      {/* ── NavItemList ────────────────────────────────────────────────── */}
      <section data-testid="catalog-nav-item-list" style={SECTION_STYLE}>
        <h2>NavItemList</h2>
        <p style={DESC_STYLE}>Renders a list of navigation links with plugin injection support.</p>
        <DemoCard code={navItemListSrc}><NavItemListDemo /></DemoCard>
      </section>

      {/* ── KeyValueEditor ─────────────────────────────────────────────── */}
      <section data-testid="catalog-key-value-editor" style={SECTION_STYLE}>
        <h2>KeyValueEditor</h2>
        <p style={DESC_STYLE}>Controlled key/value pair editor with add/remove rows.</p>
        <DemoCard code={keyValueEditorSrc}><KeyValueEditorDemo /></DemoCard>
      </section>

      {/* ── TierPicker ─────────────────────────────────────────────────── */}
      <section data-testid="catalog-tier-picker" style={SECTION_STYLE}>
        <h2>TierPicker</h2>
        <p style={DESC_STYLE}>Dropdown for selecting an AI tier from a list of AiTier objects.</p>
        <DemoCard code={tierPickerSrc}><TierPickerDemo /></DemoCard>
      </section>

      {/* ── InspectorWrapper ───────────────────────────────────────────── */}
      <section data-testid="catalog-inspector-wrapper" style={SECTION_STYLE}>
        <h2>InspectorWrapper</h2>
        <p style={DESC_STYLE}>Dev-tools overlay for slot inspection. Enable via the slot inspector shortcut (?i). Inert when inspector is off.</p>
        <DemoCard code={inspectorWrapperSrc}><InspectorWrapperDemo /></DemoCard>
      </section>

      {/* ── SettingsNav ────────────────────────────────────────────────── */}
      <section data-testid="catalog-settings-nav" style={SECTION_STYLE}>
        <h2>SettingsNav</h2>
        <DemoCard code={settingsNavSrc}><SettingsNavDemo /></DemoCard>
      </section>

      {/* ── Modal ──────────────────────────────────────────────────────── */}
      <section data-testid="catalog-modal" style={SECTION_STYLE}>
        <h2>Modal</h2>
        <p style={DESC_STYLE}>Overlay dialog with title, body, and optional footer.</p>
        <DemoCard code={modalSrc}><ModalDemo /></DemoCard>
      </section>

      {/* ── ConfirmDialog ──────────────────────────────────────────────── */}
      <section data-testid="catalog-confirm-dialog" style={SECTION_STYLE}>
        <h2>ConfirmDialog</h2>
        <p style={DESC_STYLE}>Destructive confirmation modal built on Modal.</p>
        <DemoCard code={confirmDialogSrc}><ConfirmDialogDemo /></DemoCard>
      </section>

      {/* ── KeyboardShortcutsHelp ──────────────────────────────────────── */}
      <section data-testid="catalog-keyboard-shortcuts-help" style={SECTION_STYLE}>
        <h2>KeyboardShortcutsHelp</h2>
        <p style={DESC_STYLE}>Modal listing all registered keyboard shortcuts.</p>
        <DemoCard code={keyboardShortcutsHelpSrc}><KeyboardShortcutsHelpDemo /></DemoCard>
      </section>

      {/* ── ExtensionSlot ──────────────────────────────────────────────── */}
      <section data-testid="catalog-extension-slot" style={SECTION_STYLE}>
        <h2>ExtensionSlot</h2>
        <p style={DESC_STYLE}>
          Plugin contribution container. No plugins contribute to the demo slot below so
          it renders its emptyFallback. Enable the slot inspector shortcut (?i) to see
          the dev overlay.
        </p>
        <DemoCard code={extensionSlotSrc}><ExtensionSlotDemo /></DemoCard>
      </section>
    </div>
  );
}
