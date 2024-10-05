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
    // Handle errors loading secrets if necessary
    // Optionally log or throw an error
  }
}

// Define the upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  const containerName = "uploads";

  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURESTORAGECONNECTIONSTRING
    );
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Upload the file
    const blobName = req.file.originalname;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.upload(req.file.buffer, req.file.size);

    // Generate a unique, time-limited link
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + 24); // expiry time to 24 hours

    const sasOptions = {
      containerName,
      blobName,
      expiresOn: expiryDate,
      permissions: BlobSASPermissions.parse("r"), // Read permission
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      blockBlobClient.credential
    ).toString();
    const fileUrl = `${blockBlobClient.url}?${sasToken}`;

    res.json({ fileUrl }); // Return the URL to the user
  } catch (error) {
    res.status(500).send("Error uploading file");
  }
});

// Load secrets and start the application
loadSecrets().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT);
});
