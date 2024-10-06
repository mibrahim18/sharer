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
});

app.use(express.static(path.join(__dirname, "public")));
console.log("new");

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

    console.log("Secrets loaded successfully.");
  } catch (error) {
    console.error("Error loading secrets from Azure Key Vault:", error.message);
  }
}

// Define the upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  const containerName = "uploads";

  if (!req.file) {
    return res.status(400).json({
      message: "No file uploaded.",
      error: "Please select a file and try again.",
    });
  }

  try {
    const connectionString = process.env.AZURESTORAGECONNECTIONSTRING;

    if (!connectionString) {
      throw new Error("Azure Storage connection string is not defined.");
    }

    const blobServiceClient =
      BlobServiceClient.fromConnectionString(connectionString);
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
    console.error("Error uploading file:", error);

    // Send a detailed error message and stack trace to the frontend
    let errorMessage = "Error uploading file to Azure Blob Storage.";

    if (error.message.includes("startsWith")) {
      errorMessage =
        "Azure Storage connection string is not correctly formatted.";
    } else if (error.message.includes("Key Vault")) {
      errorMessage = "Error retrieving secrets from Azure Key Vault.";
    } else if (error.message.includes("getSecret")) {
      errorMessage = "Issue with accessing Azure Key Vault.";
    }

    res.status(500).json({
      message: errorMessage,
      error: error.message,
      stack: error.stack,
    });
  }
});

// Load secrets and start the application
loadSecrets().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
});
