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
  status: string;
  encryptedAmount: string;
  isVerified?: boolean;
  decryptedValue?: number;
  creator: string;
  timestamp: number;
  publicValue1: number;
  publicValue2: number;
}

interface OperationHistory {
  id: number;
  type: string;
  description: string;
  timestamp: number;
  status: string;
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
    status: "pending" as const, 
    message: "" 
  });
  const [newSubscriptionData, setNewSubscriptionData] = useState({ 
    name: "", 
    amount: "", 
    frequency: "monthly",
    nextBilling: "" 
  });
  const [selectedSubscription, setSelectedSubscription] = useState<Subscription | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [operationHistory, setOperationHistory] = useState<OperationHistory[]>([]);
  const itemsPerPage = 6;

  const { status, initialize, isInitialized } = useFhevm();
  const { encrypt, isEncrypting} = useEncrypt();
  const { verifyDecryption, isDecrypting: fheIsDecrypting } = useDecrypt();
  const [fhevmInitializing, setFhevmInitializing] = useState(false);

  useEffect(() => {
    const initFhevmAfterConnection = async () => {
      if (!isConnected) return;
      if (isInitialized) return;
      if (fhevmInitializing) return;
      
      try {
        setFhevmInitializing(true);
        await initialize();
      } catch (error) {
        setTransactionStatus({ 
          visible: true, 
          status: "error", 
          message: "FHEVM initialization failed" 
        });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      } finally {
        setFhevmInitializing(false);
      }
    };

    initFhevmAfterConnection();
  }, [isConnected, isInitialized, initialize, fhevmInitializing]);

  useEffect(() => {
    const loadData = async () => {
      if (!isConnected) {
        setLoading(false);
        return;
      }
      
      try {
        await loadSubscriptions();
        addHistory("System", "FHE System initialized successfully", "success");
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [isConnected]);

  const addHistory = (type: string, description: string, status: string) => {
    const history: OperationHistory = {
      id: Date.now(),
      type,
      description,
      timestamp: Date.now(),
      status
    };
    setOperationHistory(prev => [history, ...prev.slice(0, 49)]);
  };

  const loadSubscriptions = async () => {
    if (!isConnected) return;
    
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const businessIds = await contract.getAllBusinessIds();
      const subscriptionsList: Subscription[] = [];
      
      for (const businessId of businessIds) {
        try {
          const businessData = await contract.getBusinessData(businessId);
          subscriptionsList.push({
            id: businessId,
            name: businessData.name,
            amount: Number(businessData.publicValue1) || 0,
            frequency: "monthly",
            nextBilling: Number(businessData.timestamp) + 30 * 24 * 60 * 60,
            status: "active",
            encryptedAmount: businessId,
            isVerified: businessData.isVerified,
            decryptedValue: Number(businessData.decryptedValue) || 0,
            creator: businessData.creator,
            timestamp: Number(businessData.timestamp),
            publicValue1: Number(businessData.publicValue1) || 0,
            publicValue2: Number(businessData.publicValue2) || 0
          });
        } catch (e) {
          console.error('Error loading subscription data:', e);
        }
      }
      
      setSubscriptions(subscriptionsList);
      addHistory("Data Load", `Loaded ${subscriptionsList.length} subscriptions`, "success");
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      addHistory("Data Load", "Failed to load subscription data", "error");
    } finally { 
      setIsRefreshing(false); 
    }
  };

  const createSubscription = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setCreatingSubscription(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating encrypted subscription..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const amountValue = parseInt(newSubscriptionData.amount) || 0;
      const businessId = `sub-${Date.now()}`;
      
      const encryptedResult = await encrypt(await contract.getAddress(), address, amountValue);
      
      const tx = await contract.createBusinessData(
        businessId,
        newSubscriptionData.name,
        encryptedResult.encryptedData,
        encryptedResult.proof,
        amountValue,
        0,
        `Subscription: ${newSubscriptionData.frequency}`
      );
      
      setTransactionStatus({ visible: true, status: "pending", message: "Waiting for confirmation..." });
      await tx.wait();
      
      setTransactionStatus({ visible: true, status: "success", message: "Subscription created successfully!" });
      addHistory("Create", `Created subscription: ${newSubscriptionData.name}`, "success");
      
      await loadSubscriptions();
      setShowCreateModal(false);
      setNewSubscriptionData({ name: "", amount: "", frequency: "monthly", nextBilling: "" });
    } catch (e: any) {
      const errorMessage = e.message?.includes("user rejected transaction") 
        ? "Transaction rejected" 
        : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      addHistory("Create", `Failed to create subscription: ${errorMessage}`, "error");
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreatingSubscription(false); 
    }
  };

  const decryptAmount = async (businessId: string): Promise<number | null> => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    try {
      const contractRead = await getContractReadOnly();
      if (!contractRead) return null;
      
      const businessData = await contractRead.getBusinessData(businessId);
      if (businessData.isVerified) {
        const storedValue = Number(businessData.decryptedValue) || 0;
        setTransactionStatus({ visible: true, status: "success", message: "Data already verified" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
        addHistory("Decrypt", `Verified amount: ${storedValue} for ${businessData.name}`, "success");
        return storedValue;
      }
      
      const contractWrite = await getContractWithSigner();
      if (!contractWrite) return null;
      
      const encryptedValueHandle = await contractRead.getEncryptedValue(businessId);
      
      const result = await verifyDecryption(
        [encryptedValueHandle],
        await contractWrite.getAddress(),
        (abiEncodedClearValues: string, decryptionProof: string) => 
          contractWrite.verifyDecryption(businessId, abiEncodedClearValues, decryptionProof)
      );
      
      setTransactionStatus({ visible: true, status: "pending", message: "Verifying decryption..." });
      
      const clearValue = result.decryptionResult.clearValues[encryptedValueHandle];
      await loadSubscriptions();
      
      setTransactionStatus({ visible: true, status: "success", message: "Amount decrypted successfully!" });
      addHistory("Decrypt", `Decrypted amount: ${clearValue} for ${businessData.name}`, "success");
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      
      return Number(clearValue);
      
    } catch (e: any) { 
      if (e.message?.includes("Data already verified")) {
        setTransactionStatus({ visible: true, status: "success", message: "Data is already verified" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
        await loadSubscriptions();
        return null;
      }
      
      setTransactionStatus({ visible: true, status: "error", message: "Decryption failed" });
      addHistory("Decrypt", "Failed to decrypt subscription amount", "error");
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
  };

  const callIsAvailable = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const result = await contract.isAvailable();
      setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
      addHistory("Check", "Checked contract availability", "success");
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      addHistory("Check", "Failed to check contract availability", "error");
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const filteredSubscriptions = subscriptions.filter(sub => 
    sub.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    sub.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const paginatedSubscriptions = filteredSubscriptions.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const totalPages = Math.ceil(filteredSubscriptions.length / itemsPerPage);

  const stats = {
    total: subscriptions.length,
    active: subscriptions.filter(s => s.status === "active").length,
    verified: subscriptions.filter(s => s.isVerified).length,
    totalMonthly: subscriptions.reduce((sum, sub) => sum + (sub.isVerified ? (sub.decryptedValue || 0) : 0), 0)
  };

  if (!isConnected) {
    return (
      <div className="app-container">
        <header className="app-header">
          <div className="logo">
            <h1>SubGuard FHE 🔐</h1>
            <span>Privacy Subscription Manager</span>
          </div>
          <div className="header-actions">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </header>
        
        <div className="connection-prompt">
          <div className="connection-content">
            <div className="connection-icon">🔒</div>
            <h2>Connect Your Wallet to Continue</h2>
            <p>Protect your subscription data with FHE encryption. Connect your wallet to start managing subscriptions privately.</p>
            <div className="connection-steps">
              <div className="step">
                <span>1</span>
                <p>Connect wallet to initialize FHE system</p>
              </div>
              <div className="step">
                <span>2</span>
                <p>Add subscriptions with encrypted amounts</p>
              </div>
              <div className="step">
                <span>3</span>
                <p>Manage payments privately</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!isInitialized || fhevmInitializing) {
    return (
      <div className="loading-screen">
        <div className="fhe-spinner"></div>
        <p>Initializing FHE Encryption System...</p>
        <p className="loading-note">Securing your subscription data</p>
      </div>
    );
  }

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Loading encrypted subscriptions...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>SubGuard FHE 🔐</h1>
          <span>Privacy-First Subscription Management</span>
        </div>
        
        <div className="header-actions">
          <button onClick={callIsAvailable} className="check-btn">
            Check Contract
          </button>
          <button onClick={() => setShowCreateModal(true)} className="create-btn">
            + Add Subscription
          </button>
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>
      
      <div className="main-content">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">📊</div>
            <div className="stat-content">
              <h3>Total Subscriptions</h3>
              <div className="stat-value">{stats.total}</div>
            </div>
          </div>
          
          <div className="stat-card">
            <div className="stat-icon">✅</div>
            <div className="stat-content">
              <h3>Active</h3>
              <div className="stat-value">{stats.active}</div>
            </div>
          </div>
          
          <div className="stat-card">
            <div className="stat-icon">🔐</div>
            <div className="stat-content">
              <h3>Encrypted</h3>
              <div className="stat-value">{stats.verified}</div>
            </div>
          </div>
          
          <div className="stat-card">
            <div className="stat-icon">💳</div>
            <div className="stat-content">
              <h3>Monthly Total</h3>
              <div className="stat-value">${stats.totalMonthly}</div>
            </div>
          </div>
        </div>

        <div className="content-grid">
          <div className="subscriptions-section">
            <div className="section-header">
              <h2>Your Subscriptions</h2>
              <div className="header-controls">
                <div className="search-box">
                  <input 
                    type="text" 
                    placeholder="Search subscriptions..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <button onClick={loadSubscriptions} className="refresh-btn" disabled={isRefreshing}>
                  {isRefreshing ? "🔄" : "Refresh"}
                </button>
              </div>
            </div>
            
            <div className="subscriptions-list">
              {paginatedSubscriptions.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📋</div>
                  <p>No subscriptions found</p>
                  <button onClick={() => setShowCreateModal(true)} className="create-btn">
                    Add Your First Subscription
                  </button>
                </div>
              ) : (
                <>
                  {paginatedSubscriptions.map((sub, index) => (
                    <div 
                      key={sub.id}
                      className={`subscription-card ${selectedSubscription?.id === sub.id ? 'selected' : ''}`}
                      onClick={() => setSelectedSubscription(sub)}
                    >
                      <div className="card-header">
                        <h3>{sub.name}</h3>
                        <span className={`status-badge ${sub.status}`}>{sub.status}</span>
                      </div>
                      <div className="card-content">
                        <div className="amount-section">
                          <span className="amount-label">Amount:</span>
                          <span className="amount-value">
                            {sub.isVerified ? `$${sub.decryptedValue}` : '🔒 Encrypted'}
                          </span>
                        </div>
                        <div className="frequency">{sub.frequency}</div>
                        <div className="next-billing">
                          Next: {new Date(sub.nextBilling * 1000).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="card-footer">
                        <span className="creator">By: {sub.creator.substring(0, 6)}...{sub.creator.substring(38)}</span>
                        {sub.isVerified && <span className="verified-badge">✅ Verified</span>}
                      </div>
                    </div>
                  ))}
                  
                  {totalPages > 1 && (
                    <div className="pagination">
                      <button 
                        onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                        disabled={currentPage === 1}
                      >
                        Previous
                      </button>
                      <span>Page {currentPage} of {totalPages}</span>
                      <button 
                        onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                        disabled={currentPage === totalPages}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="sidebar">
            <div className="fhe-info-panel">
              <h3>FHE Encryption Flow</h3>
              <div className="flow-steps">
                <div className="flow-step">
                  <div className="step-number">1</div>
                  <div className="step-content">
                    <strong>Encrypt Amount</strong>
                    <p>Subscription amounts are encrypted using FHE</p>
                  </div>
                </div>
                <div className="flow-step">
                  <div className="step-number">2</div>
                  <div className="step-content">
                    <strong>Store Encrypted</strong>
                    <p>Only encrypted data is stored on-chain</p>
                  </div>
                </div>
                <div className="flow-step">
                  <div className="step-number">3</div>
                  <div className="step-content">
                    <strong>Decrypt Locally</strong>
                    <p>Decrypt amounts securely in your browser</p>
                  </div>
                </div>
                <div className="flow-step">
                  <div className="step-number">4</div>
                  <div className="step-content">
                    <strong>Verify On-chain</strong>
                    <p>Submit proof for on-chain verification</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="history-panel">
              <h3>Operation History</h3>
              <div className="history-list">
                {operationHistory.slice(0, 5).map(record => (
                  <div key={record.id} className="history-item">
                    <div className="history-type">{record.type}</div>
                    <div className="history-desc">{record.description}</div>
                    <div className="history-time">
                      {new Date(record.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
                {operationHistory.length === 0 && (
                  <p className="no-history">No operations yet</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {showCreateModal && (
        <CreateSubscriptionModal 
          onSubmit={createSubscription} 
          onClose={() => setShowCreateModal(false)} 
          creating={creatingSubscription} 
          subscriptionData={newSubscriptionData} 
          setSubscriptionData={setNewSubscriptionData}
          isEncrypting={isEncrypting}
        />
      )}
      
      {selectedSubscription && (
        <SubscriptionDetailModal 
          subscription={selectedSubscription} 
          onClose={() => setSelectedSubscription(null)} 
          decryptAmount={() => decryptAmount(selectedSubscription.id)}
          isDecrypting={fheIsDecrypting}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

const CreateSubscriptionModal: React.FC<{
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  subscriptionData: any;
  setSubscriptionData: (data: any) => void;
  isEncrypting: boolean;
}> = ({ onSubmit, onClose, creating, subscriptionData, setSubscriptionData, isEncrypting }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setSubscriptionData({ ...subscriptionData, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>Add New Subscription</h2>
          <button onClick={onClose} className="close-modal">×</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <strong>FHE 🔐 Protection</strong>
            <p>Subscription amount will be encrypted using Zama FHE technology</p>
          </div>
          
          <div className="form-group">
            <label>Service Name *</label>
            <input 
              type="text" 
              name="name" 
              value={subscriptionData.name} 
              onChange={handleChange} 
              placeholder="Netflix, Spotify, etc." 
            />
          </div>
          
          <div className="form-group">
            <label>Amount (USD) *</label>
            <input 
              type="number" 
              name="amount" 
              value={subscriptionData.amount} 
              onChange={handleChange} 
              placeholder="0" 
              min="0"
              step="0.01"
            />
            <div className="data-type-label">FHE Encrypted Integer</div>
          </div>
          
          <div className="form-group">
            <label>Billing Frequency *</label>
            <select name="frequency" value={subscriptionData.frequency} onChange={handleChange}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={creating || isEncrypting || !subscriptionData.name || !subscriptionData.amount} 
            className="submit-btn"
          >
            {creating || isEncrypting ? "Encrypting..." : "Create Subscription"}
          </button>
        </div>
      </div>
    </div>
  );
};

const SubscriptionDetailModal: React.FC<{
  subscription: Subscription;
  onClose: () => void;
  decryptAmount: () => Promise<number | null>;
  isDecrypting: boolean;
}> = ({ subscription, onClose, decryptAmount, isDecrypting }) => {
  const handleDecrypt = async () => {
    await decryptAmount();
  };

  return (
    <div className="modal-overlay">
      <div className="detail-modal">
        <div className="modal-header">
          <h2>Subscription Details</h2>
          <button onClick={onClose} className="close-modal">×</button>
        </div>
        
        <div className="modal-body">
          <div className="subscription-info">
            <div className="info-row">
              <span>Service Name:</span>
              <strong>{subscription.name}</strong>
            </div>
            <div className="info-row">
              <span>Billing Frequency:</span>
              <span>{subscription.frequency}</span>
            </div>
            <div className="info-row">
              <span>Next Billing Date:</span>
              <span>{new Date(subscription.nextBilling * 1000).toLocaleDateString()}</span>
            </div>
            <div className="info-row">
              <span>Status:</span>
              <span className={`status-badge ${subscription.status}`}>{subscription.status}</span>
            </div>
            <div className="info-row">
              <span>Created by:</span>
              <span>{subscription.creator.substring(0, 6)}...{subscription.creator.substring(38)}</span>
            </div>
          </div>
          
          <div className="amount-section">
            <h3>Encrypted Amount</h3>
            <div className="amount-display">
              {subscription.isVerified ? (
                <div className="decrypted-amount">
                  <span className="amount">${subscription.decryptedValue}</span>
                  <span className="verified-badge">✅ On-chain Verified</span>
                </div>
              ) : (
                <div className="encrypted-amount">
                  <span className="amount">🔒 Encrypted</span>
                  <span className="encryption-info">FHE Protected</span>
                </div>
              )}
            </div>
            
            <button 
              className={`decrypt-btn ${subscription.isVerified ? 'verified' : ''}`}
              onClick={handleDecrypt}
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : 
               subscription.isVerified ? "✅ Verified" : "🔓 Decrypt Amount"}
            </button>
          </div>
          
          <div className="fhe-explanation">
            <h4>How FHE Protection Works</h4>
            <p>Your subscription amount is encrypted using Fully Homomorphic Encryption (FHE). 
            This means the amount is hidden from everyone, including the blockchain, while still 
            allowing you to manage and verify your payments.</p>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;

