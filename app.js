const express = require("express");
const path = require("path");
const multer = require("multer");
const {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB limit
}); // Use memory storage for file uploads

app.use(express.static(path.join(__dirname, "public")));

// Azure Key Vault configuration
const keyVaultName = process.env.KEY_VAULT_NAME;
const keyVaultUrl = `https://${keyVaultName}.vault.azure.net/`;

// Create a secret client
const credential = new DefaultAzureCredential();
const secretClient = new SecretClient(keyVaultUrl, credential);

// Load connection string and account details from Azure Key Vault
async function loadSecrets() {
  try {
    const connectionStringSecret = await secretClient.getSecret(
      "AZURESTORAGECONNECTIONSTRING"
    );
    const accountNameSecret = await secretClient.getSecret(
      "AZURESTORAGEACCOUNTNAME"
    );
    const accountKeySecret = await secretClient.getSecret(
      "AZURESTORAGEACCOUNTKEY"
    );

    // Store secrets in process environment variables
    process.env.AZURESTORAGECONNECTIONSTRING = connectionStringSecret.value;
    process.env.AZURESTORAGEACCOUNTNAME = accountNameSecret.value;
    process.env.AZURESTORAGEACCOUNTKEY = accountKeySecret.value;
  } catch (error) {
    console.error("Error loading secrets from Azure Key Vault:", error.message);
  }
}

// Define the upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  const containerName = "uploads";

  if (!req.file) {
    console.error("No file uploaded");
    return res.status(400).json({
      message: "No file uploaded.",
      error: "File input is missing.",
    });
  }

  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURESTORAGECONNECTIONSTRING
    );
    const containerClient = blobServiceClient.getContainerClient(containerName);

    console.log("Uploading file:", req.file.originalname);

    const blobName = req.file.originalname;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.upload(req.file.buffer, req.file.size);

    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + 24);

    const sasOptions = {
      containerName,
      blobName,
      expiresOn: expiryDate,
      permissions: BlobSASPermissions.parse("r"),
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      blockBlobClient.credential
    ).toString();

    const fileUrl = `${blockBlobClient.url}?${sasToken}`;
    console.log("File uploaded successfully, URL:", fileUrl);

    res.json({ fileUrl });
  } catch (error) {
    console.error("Error uploading file:", error.message || error);

    // Check for specific error cases
    let responseMessage = {
      message: "Error uploading file to Azure Blob Storage.",
      error: error.message || error.toString(),
      stack: error.stack || "No stack available", // Log the stack trace for debugging
    };

    if (error.name === "RestError") {
      console.error("Azure SDK Error:", error.details);
      responseMessage = {
        message: "Azure Storage upload failed.",
        details: error.details || "Unknown error.",
      };
      return res.status(500).json(responseMessage);
    } else if (error.code === "ENOTFOUND") {
      console.error("Network Error:", error);
      responseMessage = {
        message: "Network error while connecting to Azure Storage.",
        details: error.message || "Unable to reach storage service.",
      };
      return res.status(500).json(responseMessage);
    } else if (error.message && error.message.includes("Key Vault")) {
      console.error("Key Vault Error:", error);
      responseMessage = {
        message: "Error retrieving secrets from Azure Key Vault.",
        details: error.message,
      };
      return res.status(500).json(responseMessage);
    }

    // General error handling
    res.status(500).json(responseMessage);
  }
});

// Load secrets and start the application
loadSecrets().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});
