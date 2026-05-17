import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { SectionCard, DomainList, SectionHeading } from './SettingsShared';
import type { BlockedDomain, HiddenDomain } from '../../../shared/types/api';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { ClientCertsSection } from '../intercept/ClientCertsSection';

export function TrafficSection() {
  const ws = useWebSocket();
  const toast = useToast();
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true);
  const [domains, setDomains] = useState<BlockedDomain[]>([]);
  const [hiddenDomains, setHiddenDomains] = useState<HiddenDomain[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [showHiddenModal, setShowHiddenModal] = useState(false);
  const [hiddenDomainInput, setHiddenDomainInput] = useState('');

  const fetchDomains = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/blocklist/list');
      setDomains(res.body?.data || []);
    } catch {
      // ignore
    }
  }, [ws]);

  const fetchHiddenDomains = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/hiddenlist/list');
      setHiddenDomains(res.body?.data || []);
    } catch {
      // ignore
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected && hasScope('core.traffic:manage')) {
      fetchDomains();
      fetchHiddenDomains();
    }
  }, [ws.connected, fetchDomains, fetchHiddenDomains]);

  const handleAdd = async () => {
    if (!domainInput.trim()) return;
    try {
      await ws.sendRestApi('POST', '/v1/blocklist/add', { domain: domainInput.trim() });
      setShowModal(false);
      setDomainInput('');
      fetchDomains();
      toast.success('Blocked domain added');
    } catch {
      toast.error('Failed to add blocked domain');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/blocklist/remove/${id}`);
      fetchDomains();
      toast.success('Blocked domain removed');
    } catch {
      toast.error('Failed to remove blocked domain');
    }
  };

  const handleAddHidden = async () => {
    if (!hiddenDomainInput.trim()) return;
    try {
      await ws.sendRestApi('POST', '/v1/hiddenlist/add', { domain: hiddenDomainInput.trim() });
      setShowHiddenModal(false);
      setHiddenDomainInput('');
      fetchHiddenDomains();
      toast.success('Hidden domain added');
    } catch {
      toast.error('Failed to add hidden domain');
    }
  };

  const handleDeleteHidden = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/hiddenlist/remove/${id}`);
      fetchHiddenDomains();
      toast.success('Hidden domain removed');
    } catch {
      toast.error('Failed to remove hidden domain');
    }
  };

  return (
    <div id="section-traffic">
      <SectionHeading>Traffic Control</SectionHeading>

      <SectionCard
        id="blocked-domains"
        title="Blocked Domains"
        description="Blocked at the proxy level during traffic capture. Subdomains are automatically included."
      >
        <DomainList
          domains={domains}
          onDelete={handleDelete}
          onAdd={() => { setDomainInput(''); setShowModal(true); }}
          testIdPrefix="domain"
          emptyText="No blocked domains configured."
        />
      </SectionCard>

      <SectionCard
        id="hidden-domains"
        title="Hidden Domains"
        description="Traffic still reaches the device but won't appear in capture sessions."
      >
        <DomainList
          domains={hiddenDomains}
          onDelete={handleDeleteHidden}
          onAdd={() => { setHiddenDomainInput(''); setShowHiddenModal(true); }}
          testIdPrefix="hidden-domain"
          emptyText="No hidden domains configured."
        />
      </SectionCard>

      <SectionCard
        id="client-certs"
        title="mTLS Client Certificates"
        description="Client certificates used for mutual TLS authentication during traffic capture. Each certificate can be scoped to specific hostnames."
      >
        <ClientCertsSection />
      </SectionCard>

      {showModal && (
        <Modal
          title="Add Blocked Domain"
          onClose={() => setShowModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAdd} data-testid="save-domain-btn">
                Add
              </button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="settings-blocked-domain">Domain</label>
            <input
              id="settings-blocked-domain"
              className="form-input"
              value={domainInput}
              onChange={e => setDomainInput(e.target.value)}
              placeholder="example.com"
              data-testid="domain-input"
            />
            <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              Subdomains (e.g. sub.example.com) will also be blocked.
            </small>
          </div>
        </Modal>
      )}

      {showHiddenModal && (
        <Modal
          title="Add Hidden Domain"
          onClose={() => setShowHiddenModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowHiddenModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddHidden} data-testid="save-hidden-domain-btn">
                Add
              </button>
            </>
          }
        >
          <div className="form-group">
            <label htmlFor="settings-hidden-domain">Domain</label>
            <input
              id="settings-hidden-domain"
              className="form-input"
              value={hiddenDomainInput}
              onChange={e => setHiddenDomainInput(e.target.value)}
              placeholder="example.com"
              data-testid="hidden-domain-input"
            />
            <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              Subdomains (e.g. sub.example.com) will also be hidden.
            </small>
          </div>
        </Modal>
      )}
    </div>
  );
}
