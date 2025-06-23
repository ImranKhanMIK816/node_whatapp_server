const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const bodyParser = require('body-parser');
const url = require('url') ;
const app = express();
const fs = require('fs');
const path = require('path');
const clients = {};       // existing clients
const clientStates = {};
const port = process.env.PORT || 8080;

// ✅ Enable CORS for your frontend domain
app.use(cors());

app.use(express.json());
app.use(bodyParser.json());


const qrCodes = {};  // Stores QR codes temporarily by userId

// Create and initialize WhatsApp client for a specific user
function startClientForUser(userId) {
   const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: `./sessions/user-${userId}` // full path for isolation
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }

    });

    clients[userId] = client;

    client.on('qr', async (qr) => {
        try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            qrCodes[userId] = qrDataUrl;

            await axios.post('http://localhost/sorin/api/update-qr', {
                user_id: userId,
                qr_code: qrDataUrl
            });

            //console.log(`QR code sent for user ${userId}`);
        } catch (err) {
            console.error('Error generating or sending QR:', err.message);
        }
    });

    client.on('ready', async () => {
        //console.log(`WhatsApp client is ready for user ${userId}`);

        try {
            await axios.post('http://localhost/sorin/api/update-status', {
                user_id: userId,
                status: 1
            });
        } catch (err) {
            console.error('Error updating status to Laravel:', err.message);
        }
    });

    client.on('message', async (message) => {
        try {
            await axios.post('http://localhost/sorin/api/receive-whatsapp-message', {
                user_id: userId,
                from: message.from,
                body: message.body
            });
        } catch (err) {
            console.error('Error forwarding message:', err.message);
        }
    });


client.on('disconnected', async (reason) => {
    //console.log(`Client disconnected for user ${userId}: ${reason}`);

    // Flag to prevent double destroy
    if (clients[userId]?.isDestroying) return;
    clients[userId].isDestroying = true;

    // Step 1: Destroy client
    try {
        await client.destroy();
        await new Promise(res => setTimeout(res, 1000)); // Add delay before folder ops
    } catch (err) {
        console.warn(`Failed to destroy client for user ${userId}:`, err.message);
    }

    // Step 2: Delete session folder
    try {
        await deleteSessionFolder(userId);
    } catch (err) {
        console.error(`Failed to delete session folder for user ${userId}:`, err.message);
    }

    // Step 3: Update Laravel
    try {
        await axios.post('http://localhost/sorin/api/update-status', {
            user_id: userId,
            status: 0
        });
    } catch (err) {
        console.error('Error updating status to Laravel:', err.message);
    }

    // Step 4: Cleanup
    delete clients[userId];
});



client.on('auth_failure', async (msg) => {
     //console.log(`Client auth failure for user ${userId}: ${reason}`);
// Flag to prevent double destroy
    if (clients[userId]?.isDestroying) return;
    clients[userId].isDestroying = true;

    // Step 1: Destroy client
    try {
        await client.destroy();
        await new Promise(res => setTimeout(res, 1000)); // Add delay before folder ops
    }catch (err) {
        console.warn(`Failed to destroy client for user ${userId}:`, err.message);
    }

    try {
        await deleteSessionFolder(userId);
    }catch (err) {
        console.error(`Failed to delete session folder for user ${userId}:`, err.message);
    }

    // Step 3: Update Laravel
    try {
        await axios.post('http://localhost/sorin/api/update-status', {
            user_id: userId,
            status: 0
        });
    }catch (err) {
        console.error('Error updating status to Laravel:', err.message);
    }

    // Step 4: Cleanup
    delete clients[userId];
});

client.on('authenticated', () => {
    //console.log(`User ${userId} scanned QR and is authenticating...`);
    clientStates[userId] = 'authenticated';
});



    client.initialize();
    
    
}

function deleteSessionFolder(userId, retryCount = 0) {
    const sessionPath = path.join(__dirname, 'sessions', `user-${userId}`);
    //console.log(`Attempting to delete: ${sessionPath}`);

    return new Promise((resolve, reject) => {
        fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
            if (err) {
                if ((err.code === 'EBUSY' || err.code === 'EPERM') && retryCount < 5) {
                    console.warn(`Session folder for user ${userId} is locked. Retrying in 2s...`);
                    setTimeout(() => {
                        deleteSessionFolder(userId, retryCount + 1).then(resolve).catch(reject);
                    }, 2000);
                } else {
                    console.error(`Failed to delete session folder for user ${userId}:`, err.message);
                    reject(err);
                }
            } else {
                fs.access(sessionPath, fs.constants.F_OK, (existsErr) => {
                    if (!existsErr) {
                        if (retryCount < 5) {
                            console.warn(`Folder still exists after deletion for user ${userId}. Retrying...`);
                            setTimeout(() => {
                                deleteSessionFolder(userId, retryCount + 1).then(resolve).catch(reject);
                            }, 2000);
                        } else {
                            console.error(`Could not delete folder after multiple attempts: ${sessionPath}`);
                            reject(new Error('Folder still exists after multiple attempts'));
                        }
                    } else {
                        //console.log(`Deleted session folder for user ${userId}`);
                        resolve();
                    }
                });
            }
        });
    });
}


process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});


// ========================= API ROUTES ==========================

// Start a new WhatsApp client for a user
app.post('/start-client', async (req, res) => {
    const userId = req.body.user_id;
    if (!userId) return res.status(400).send('Missing user_id');

    if (!clients[userId]) {
        startClientForUser(userId);
        return res.send({ message: 'Client initialized' });
    } else {
        return res.send({ message: 'Client already running' });
    }
});

// Get the QR code for a user
app.get('/qr/:userId', (req, res) => {
    const userId = req.params.userId;
    if (qrCodes[userId]) {
        res.send({ qr: qrCodes[userId] });
    } else {
        res.send({ message: 'QR not generated yet' });
    }
});

// Run sync task for user: get contacts + last messages
app.post('/run-client-task', async (req, res) => {
    const userId = req.body.user_id;
    const client = clients[userId];
    //console.log(client)
    if (!client) return res.status(404).send('Client not running');

    try {
        const chats = await client.getChats();


        const contacts = [];

        for (const chat of chats) {
            const contactInfo = {
                id: chat.id._serialized,
                name: chat.name || chat.id.user,
                isGroup: chat.isGroup,
            
            };
            

            const messages = await chat.fetchMessages({ limit: 1 });
            if (messages.length > 0) {
                const lastMessage = messages[0];
                contactInfo.lastMessage = {
                    from: lastMessage.from,
                    body: lastMessage.body,
                    timestamp: lastMessage.timestamp
                };
            } else {
                contactInfo.lastMessage = null;
            }

            contacts.push(contactInfo);
        }

        await axios.post('http://localhost/sorin/api/receive-whatsapp-contacts', {
            user_id: userId,
            contacts: contacts
        });

        res.send({ message: 'Contacts sent to Laravel' });
    } catch (err) {
        console.error('Error syncing contacts:', err.message);
        res.status(500).send('Error syncing contacts');
    }
});

app.post('/logout', async (req, res) => {
    const userId = req.body.user_id;

    const client = clients[userId];
    if (!client) {
        return res.status(404).json({ success: false, message: 'Client not found' });
    }

    try {
        //console.log(`Logging out client for user ${userId}`);

        // Step 1: Logout from WhatsApp
        await client.logout(); // logs out from WhatsApp account

        // Step 2: Destroy client (close browser instance)
        await client.destroy();
        await new Promise(res => setTimeout(res, 1000)); // short delay to release resources

        // Step 3: Delete session folder
        await deleteSessionFolder(userId);

        // Step 4: Update user status in Laravel
        await axios.post('http://localhost/sorin/api/update-status', {
            user_id: userId,
            status: 0
        });

        // Step 5: Remove from memory
        delete clients[userId];

        return res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        console.error(`Manual logout failed for user ${userId}:`, err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/client-status/:userId', (req, res) => {
    const userId = req.params.userId;
    const client = clients[userId];

    if (!client) {
        return res.json({ status: 'not_started' });
    }

    // NEW: check if user scanned QR but not fully ready
  
    if (client.info && client.info.wid) {
        return res.json({ status: 'ready' });
    }

    return res.json({ status: 'starting' });
    return NextResponse.json({ success: true, message: "Success" }, { status: 200 });
});


// ================================================================

app.listen(port, () => {
    //console.log(`WhatsApp Node.js server running at http://localhost:${port}`);
    //console.log(`${url}`);
});
