import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { getContractReadOnly, getContractWithSigner } from "./components/useContract";
import "./App.css";
import { useAccount } from 'wagmi';
import { useFhevm, useEncrypt, useDecrypt } from '../fhevm-sdk/src';

interface Subscription {
  id: string;
  name: string;
  amount: number;
  frequency: string;
  nextBilling: number;
  merchant: string;
  status: string;
  isVerified?: boolean;
  decryptedValue?: number;
  publicValue1: number;
  publicValue2: number;
  timestamp: number;
  creator: string;
}

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const [loading, setLoading] = useState(true);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingSubscription, setCreatingSubscription] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ 
    visible: false, 
    status: "pending", 
    message: "" 
  });
  const [newSubscriptionData, setNewSubscriptionData] = useState({ 
    name: "", 
    amount: "", 
    frequency: "monthly", 
    merchant: "" 
  });
  const [selectedSubscription, setSelectedSubscription] = useState<Subscription | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [stats, setStats] = useState({ total: 0, active: 0, monthly: 0, verified: 0 });

  const { status, initialize, isInitialized } = useFhevm();
  const { encrypt, isEncrypting } = useEncrypt();
  const { verifyDecryption, isDecrypting: fheIsDecrypting } = useDecrypt();

  useEffect(() => {
    const initFhevm = async () => {
      if (isConnected && !isInitialized) {
        try {
          await initialize();
        } catch (error) {
          console.error('FHEVM init failed:', error);
        }
      }
    };
    initFhevm();
  }, [isConnected, isInitialized, initialize]);

  useEffect(() => {
    const loadData = async () => {
      if (!isConnected) {
        setLoading(false);
        return;
      }
      try {
        const contract = await getContractReadOnly();
        if (!contract) return;
        
        const businessIds = await contract.getAllBusinessIds();
        const subsList: Subscription[] = [];
        
        for (const businessId of businessIds) {
          try {
            const businessData = await contract.getBusinessData(businessId);
            subsList.push({
              id: businessId,
              name: businessData.name,
              amount: Number(businessData.publicValue1) || 0,
              frequency: businessData.publicValue2 === 1 ? "monthly" : "yearly",
              nextBilling: Number(businessData.timestamp) + (businessData.publicValue2 === 1 ? 2592000 : 31536000),
              merchant: businessData.description,
              status: "active",
              isVerified: businessData.isVerified,
              decryptedValue: Number(businessData.decryptedValue) || 0,
              publicValue1: Number(businessData.publicValue1) || 0,
              publicValue2: Number(businessData.publicValue2) || 0,
              timestamp: Number(businessData.timestamp),
              creator: businessData.creator
            });
          } catch (e) {
            console.error('Error loading subscription:', e);
          }
        }
        
        setSubscriptions(subsList);
        updateStats(subsList);
      } catch (e) {
        setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [isConnected]);

  const updateStats = (subs: Subscription[]) => {
    const total = subs.length;
    const active = subs.filter(s => s.status === "active").length;
    const monthly = subs.filter(s => s.frequency === "monthly").length;
    const verified = subs.filter(s => s.isVerified).length;
    setStats({ total, active, monthly, verified });
  };

  const createSubscription = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setCreatingSubscription(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating subscription with FHE encryption..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("No contract");
      
      const amountValue = parseInt(newSubscriptionData.amount) || 0;
      const businessId = `sub-${Date.now()}`;
      const contractAddress = await contract.getAddress();
      
      const encryptedResult = await encrypt(contractAddress, address, amountValue);
      
      const tx = await contract.createBusinessData(
        businessId,
        newSubscriptionData.name,
        encryptedResult.encryptedData,
        encryptedResult.proof,
        amountValue,
        newSubscriptionData.frequency === "monthly" ? 1 : 2,
        newSubscriptionData.merchant
      );
      
      setTransactionStatus({ visible: true, status: "pending", message: "Waiting for confirmation..." });
      await tx.wait();
      
      setTransactionStatus({ visible: true, status: "success", message: "Subscription created!" });
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
      
      setShowCreateModal(false);
      setNewSubscriptionData({ name: "", amount: "", frequency: "monthly", merchant: "" });
      
      const updatedSubs = [...subscriptions, {
        id: businessId,
        name: newSubscriptionData.name,
        amount: amountValue,
        frequency: newSubscriptionData.frequency,
        nextBilling: Date.now()/1000 + (newSubscriptionData.frequency === "monthly" ? 2592000 : 31536000),
        merchant: newSubscriptionData.merchant,
        status: "active",
        publicValue1: amountValue,
        publicValue2: newSubscriptionData.frequency === "monthly" ? 1 : 2,
        timestamp: Date.now()/1000,
        creator: address
      }];
      setSubscriptions(updatedSubs);
      updateStats(updatedSubs);
    } catch (e: any) {
      const errorMessage = e.message?.includes("user rejected") 
        ? "Transaction rejected" 
        : "Creation failed";
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreatingSubscription(false); 
    }
  };

  const decryptData = async (businessId: string): Promise<number | null> => {
    if (!isConnected || !address) return null;
    
    try {
      const contractRead = await getContractReadOnly();
      if (!contractRead) return null;
      
      const businessData = await contractRead.getBusinessData(businessId);
      if (businessData.isVerified) {
        return Number(businessData.decryptedValue) || 0;
      }
      
      const contractWrite = await getContractWithSigner();
      if (!contractWrite) return null;
      
      const encryptedValueHandle = await contractRead.getEncryptedValue(businessId);
      const contractAddress = await contractWrite.getAddress();
      
      const result = await verifyDecryption(
        [encryptedValueHandle],
        contractAddress,
        (abiEncodedClearValues: string, decryptionProof: string) => 
          contractWrite.verifyDecryption(businessId, abiEncodedClearValues, decryptionProof)
      );
      
      const clearValue = result.decryptionResult.clearValues[encryptedValueHandle];
      return Number(clearValue);
      
    } catch (e: any) { 
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Decryption failed" 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
  };

  const handleVerifySubscription = async (subscription: Subscription) => {
    setTransactionStatus({ visible: true, status: "pending", message: "Verifying encrypted data..." });
    
    try {
      const decryptedAmount = await decryptData(subscription.id);
      if (decryptedAmount !== null) {
        const updatedSubs = subscriptions.map(sub => 
          sub.id === subscription.id 
            ? { ...sub, isVerified: true, decryptedValue: decryptedAmount }
            : sub
        );
        setSubscriptions(updatedSubs);
        updateStats(updatedSubs);
        
        setTransactionStatus({ visible: true, status: "success", message: "Data verified successfully!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
    } catch (error) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredSubscriptions = subscriptions.filter(sub => {
    const matchesSearch = sub.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         sub.merchant.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = activeFilter === "all" || 
                         (activeFilter === "verified" && sub.isVerified) ||
                         (activeFilter === "active" && sub.status === "active") ||
                         (activeFilter === "monthly" && sub.frequency === "monthly");
    return matchesSearch && matchesFilter;
  });

  if (!isConnected) {
    return (
      <div className="app-container">
        <header className="app-header">
          <div className="logo">
            <h1>SubGuard FHE 🔒</h1>
            <span>Privacy-First Subscription Manager</span>
          </div>
          <ConnectButton />
        </header>
        
        <div className="connection-prompt">
          <div className="prompt-content">
            <div className="prompt-icon">🔐</div>
            <h2>Connect Wallet to Start</h2>
            <p>Secure your subscription data with fully homomorphic encryption</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isInitialized) {
    return (
      <div className="loading-screen">
        <div className="encryption-spinner"></div>
        <p>Initializing FHE System...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-section">
          <h1>SubGuard FHE</h1>
          <span>Encrypted Subscription Management</span>
        </div>
        <div className="header-actions">
          <ConnectButton />
        </div>
      </header>

      <div className="main-content">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">📊</div>
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Total Subscriptions</div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">✅</div>
            <div className="stat-value">{stats.active}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🔐</div>
            <div className="stat-value">{stats.verified}</div>
            <div className="stat-label">FHE Verified</div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🔄</div>
            <div className="stat-value">{stats.monthly}</div>
            <div className="stat-label">Monthly</div>
          </div>
        </div>

        <div className="controls-section">
          <div className="search-filter">
            <input 
              type="text"
              placeholder="Search subscriptions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="search-input"
            />
            <select 
              value={activeFilter}
              onChange={(e) => setActiveFilter(e.target.value)}
              className="filter-select"
            >
              <option value="all">All Subscriptions</option>
              <option value="active">Active</option>
              <option value="verified">FHE Verified</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <button 
            onClick={() => setShowCreateModal(true)}
            className="create-button"
          >
            + Add Subscription
          </button>
        </div>

        <div className="subscriptions-list">
          {filteredSubscriptions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📋</div>
              <h3>No subscriptions found</h3>
              <p>Add your first encrypted subscription to get started</p>
              <button 
                onClick={() => setShowCreateModal(true)}
                className="create-button"
              >
                Create First Subscription
              </button>
            </div>
          ) : (
            filteredSubscriptions.map((sub) => (
              <div key={sub.id} className="subscription-card">
                <div className="card-header">
                  <h3>{sub.name}</h3>
                  <span className={`status-badge ${sub.status}`}>
                    {sub.status}
                  </span>
                </div>
                <div className="card-content">
                  <div className="subscription-info">
                    <div className="info-row">
                      <span>Merchant:</span>
                      <span>{sub.merchant}</span>
                    </div>
                    <div className="info-row">
                      <span>Amount:</span>
                      <span>${sub.amount} / {sub.frequency}</span>
                    </div>
                    <div className="info-row">
                      <span>Next Billing:</span>
                      <span>{new Date(sub.nextBilling * 1000).toLocaleDateString()}</span>
                    </div>
                    <div className="info-row">
                      <span>FHE Status:</span>
                      <span className={`encryption-status ${sub.isVerified ? 'verified' : 'encrypted'}`}>
                        {sub.isVerified ? '✅ Verified' : '🔒 Encrypted'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="card-actions">
                  {!sub.isVerified && (
                    <button 
                      onClick={() => handleVerifySubscription(sub)}
                      className="verify-button"
                    >
                      Verify with FHE
                    </button>
                  )}
                  <button 
                    onClick={() => setSelectedSubscription(sub)}
                    className="details-button"
                  >
                    Details
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Add New Subscription</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-button">×</button>
            </div>
            <div className="modal-body">
              <div className="fhe-notice">
                <strong>FHE Encryption Active</strong>
                <p>Payment amounts are encrypted using fully homomorphic encryption</p>
              </div>
              
              <div className="form-group">
                <label>Subscription Name</label>
                <input 
                  type="text"
                  value={newSubscriptionData.name}
                  onChange={(e) => setNewSubscriptionData({...newSubscriptionData, name: e.target.value})}
                  placeholder="Netflix, Spotify, etc."
                />
              </div>
              
              <div className="form-group">
                <label>Monthly Amount ($)</label>
                <input 
                  type="number"
                  value={newSubscriptionData.amount}
                  onChange={(e) => setNewSubscriptionData({...newSubscriptionData, amount: e.target.value})}
                  placeholder="0"
                />
              </div>
              
              <div className="form-group">
                <label>Billing Frequency</label>
                <select 
                  value={newSubscriptionData.frequency}
                  onChange={(e) => setNewSubscriptionData({...newSubscriptionData, frequency: e.target.value})}
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              
              <div className="form-group">
                <label>Merchant</label>
                <input 
                  type="text"
                  value={newSubscriptionData.merchant}
                  onChange={(e) => setNewSubscriptionData({...newSubscriptionData, merchant: e.target.value})}
                  placeholder="Company name"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button 
                onClick={createSubscription}
                disabled={creatingSubscription || isEncrypting}
                className="submit-button"
              >
                {creatingSubscription || isEncrypting ? "Encrypting..." : "Create Subscription"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedSubscription && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Subscription Details</h2>
              <button onClick={() => setSelectedSubscription(null)} className="close-button">×</button>
            </div>
            <div className="modal-body">
              <div className="detail-section">
                <h3>{selectedSubscription.name}</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span>Merchant:</span>
                    <span>{selectedSubscription.merchant}</span>
                  </div>
                  <div className="detail-item">
                    <span>Amount:</span>
                    <span>${selectedSubscription.amount}</span>
                  </div>
                  <div className="detail-item">
                    <span>Frequency:</span>
                    <span>{selectedSubscription.frequency}</span>
                  </div>
                  <div className="detail-item">
                    <span>Status:</span>
                    <span className={`status ${selectedSubscription.status}`}>
                      {selectedSubscription.status}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span>FHE Protection:</span>
                    <span className={`encryption-status ${selectedSubscription.isVerified ? 'verified' : 'encrypted'}`}>
                      {selectedSubscription.isVerified ? 'Verified' : 'Encrypted'}
                    </span>
                  </div>
                </div>
              </div>
              
              {selectedSubscription.isVerified && (
                <div className="verification-section">
                  <h4>🔐 FHE Verification Complete</h4>
                  <p>This subscription's amount has been verified using fully homomorphic encryption.</p>
                  <div className="verified-amount">
                    Decrypted Amount: ${selectedSubscription.decryptedValue}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className={`transaction-toast ${transactionStatus.status}`}>
          <div className="toast-content">
            <span className="toast-message">{transactionStatus.message}</span>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <p>SubGuard FHE - Privacy-First Subscription Management</p>
          <div className="footer-links">
            <span>FHE Encrypted</span>
            <span>Zero-Knowledge</span>
            <span>Secure Payments</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;