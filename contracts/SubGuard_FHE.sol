pragma solidity ^0.8.24;

import { FHE, euint32, externalEuint32 } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SubscriptionManager is ZamaEthereumConfig {
    struct Subscription {
        string merchantId;
        euint32 encryptedAmount;
        uint256 renewalDate;
        uint256 lastPaymentDate;
        bool isActive;
        address subscriber;
    }

    mapping(string => Subscription) private subscriptions;
    mapping(address => string[]) private userSubscriptions;
    mapping(string => string[]) private merchantSubscriptions;

    event SubscriptionCreated(
        string indexed subscriptionId,
        address indexed subscriber,
        string indexed merchantId
    );

    event PaymentProcessed(
        string indexed subscriptionId,
        uint256 paymentDate,
        uint32 decryptedAmount
    );

    event SubscriptionCancelled(
        string indexed subscriptionId,
        address indexed subscriber
    );

    modifier onlySubscriber(string calldata subscriptionId) {
        require(
            subscriptions[subscriptionId].subscriber == msg.sender,
            "Not subscription owner"
        );
        _;
    }

    constructor() ZamaEthereumConfig() {}

    function createSubscription(
        string calldata subscriptionId,
        string calldata merchantId,
        externalEuint32 encryptedAmount,
        bytes calldata amountProof,
        uint256 renewalDate
    ) external {
        require(
            subscriptions[subscriptionId].subscriber == address(0),
            "Subscription exists"
        );

        euint32 encrypted = FHE.fromExternal(encryptedAmount, amountProof);
        require(FHE.isInitialized(encrypted), "Invalid encrypted amount");

        subscriptions[subscriptionId] = Subscription({
            merchantId: merchantId,
            encryptedAmount: encrypted,
            renewalDate: renewalDate,
            lastPaymentDate: block.timestamp,
            isActive: true,
            subscriber: msg.sender
        });

        FHE.allowThis(encrypted);
        FHE.makePubliclyDecryptable(encrypted);

        userSubscriptions[msg.sender].push(subscriptionId);
        merchantSubscriptions[merchantId].push(subscriptionId);

        emit SubscriptionCreated(subscriptionId, msg.sender, merchantId);
    }

    function processRenewal(
        string calldata subscriptionId,
        bytes memory abiEncodedClearAmount,
        bytes memory decryptionProof
    ) external onlySubscriber(subscriptionId) {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.isActive, "Subscription inactive");
        require(block.timestamp >= sub.renewalDate, "Not due for renewal");

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(sub.encryptedAmount);

        FHE.checkSignatures(cts, abiEncodedClearAmount, decryptionProof);

        uint32 decryptedAmount = abi.decode(abiEncodedClearAmount, (uint32));

        sub.lastPaymentDate = block.timestamp;
        sub.renewalDate = block.timestamp + 30 days;

        emit PaymentProcessed(
            subscriptionId,
            block.timestamp,
            decryptedAmount
        );
    }

    function cancelSubscription(string calldata subscriptionId)
        external
        onlySubscriber(subscriptionId)
    {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.isActive, "Subscription inactive");

        sub.isActive = false;

        emit SubscriptionCancelled(subscriptionId, msg.sender);
    }

    function getSubscription(string calldata subscriptionId)
        external
        view
        returns (
            string memory merchantId,
            uint256 renewalDate,
            uint256 lastPaymentDate,
            bool isActive
        )
    {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.subscriber != address(0), "Subscription not found");

        return (
            sub.merchantId,
            sub.renewalDate,
            sub.lastPaymentDate,
            sub.isActive
        );
    }

    function getUserSubscriptions(address user)
        external
        view
        returns (string[] memory)
    {
        return userSubscriptions[user];
    }

    function getMerchantSubscriptions(string calldata merchantId)
        external
        view
        returns (string[] memory)
    {
        return merchantSubscriptions[merchantId];
    }

    function updateRenewalDate(
        string calldata subscriptionId,
        uint256 newRenewalDate
    ) external onlySubscriber(subscriptionId) {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.isActive, "Subscription inactive");
        sub.renewalDate = newRenewalDate;
    }

    function getEncryptedAmount(string calldata subscriptionId)
        external
        view
        returns (euint32)
    {
        return subscriptions[subscriptionId].encryptedAmount;
    }

    function isSubscriptionActive(string calldata subscriptionId)
        external
        view
        returns (bool)
    {
        return subscriptions[subscriptionId].isActive;
    }
}

