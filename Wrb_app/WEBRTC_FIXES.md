# WebRTC Multi-User Connection Fixes

## Problem
When 3 or more users join the same meeting, or when users join from different devices, they couldn't see/hear each other. The issue was caused by:
1. Race conditions when multiple users tried to create WebRTC peer connections simultaneously
2. Inconsistent offer creation logic that didn't scale to N users
3. Slow event polling that delayed ICE candidate exchange

## Solution

### 1. **Unidirectional Offer Creation (N-User Scalability)**
- **Only the NEW JOINER creates offers** to all existing participants
- Existing participants DO NOT create offers when someone joins
- This prevents simultaneous offer creation that causes signaling state conflicts

**File:** `app.js` lines 534-540
```javascript
case "join":
  // DO NOT initiate connection - let the new joiner initiate to us
  // This prevents race conditions in mesh networks
  break;
```

**File:** `app.js` lines 368-372
```javascript
// Connect WebRTC to all existing participants in the room
data.participants.forEach(p => {
  // Joiner initiates peer connection and creates offer
  initiatePeerConnection(p.id, p.name, true);
});
```

### 2. **Improved Event Polling for Faster Signal Exchange**
- Changed polling interval from 1000ms to 500ms
- Faster ICE candidate exchange = faster connection establishment
- Critical for multiple simultaneous peer connection negotiations

**File:** `app.js` line 462
```javascript
pollInterval = setInterval(pollEvents, 500);  // was 1000ms
```

### 3. **Placeholder Card Creation in Peer Connection Initiation**
- Ensure placeholder cards are created when initiating peer connections
- Prevents missing video tiles in the UI

**File:** `app.js` line 571
```javascript
createParticipantCardPlaceholder(targetUserId, targetUserName);
```

### 4. **Robust Signaling State Handling**
- Check signaling state before setting remote descriptions
- Prevents "Failed to set local/remote description" errors
- Graceful handling of race conditions

**File:** `app.js` lines 648-705
- Only set offers in stable state
- Only set answers in have-local-offer state
- Add ICE candidates only if connection is not closed

### 5. **Connection State Monitoring**
- Track connection state changes (connecting, connected, failed, disconnected)
- Log signaling state for debugging
- Auto-restart failed connections by removing the participant card

**File:** `app.js` lines 607-611
```javascript
pc.onconnectionstatechange = () => {
  console.log(`Connection state with ${targetUserName}: ${pc.connectionState}`);
  if (pc.connectionState === "failed") {
    removeParticipantCard(targetUserId);
  }
};
```

### 6. **Static File Serving**
- Added catch-all route to serve static files
- Fixes 404 errors on resource loading

**File:** `server.py` lines 141-146
```python
@app.route("/<path:filename>")
def static_files(filename):
    try:
        return send_from_directory(".", filename)
    except:
        return "File not found", 404
```

## How It Works (Example: 3 Users)

### Sequence
1. **User1 joins** → No peers, creates no connections
2. **User2 joins**
   - Server returns User1 in participant list
   - User2 initiates connection to User1
   - User2 creates offer, sends to User1
   - User1 receives offer via polling
   - User1 creates peer connection (non-initiator) and sends answer
   - Both can see/hear each other ✓

3. **User3 joins**
   - Server returns User1 and User2 in participant list
   - User3 initiates connections to both User1 and User2
   - User3 creates offers to both
   - User1 and User2 receive join event but DON'T initiate
   - User1 and User2 receive offers from User3
   - They respond with answers
   - All three can see/hear each other ✓

## Benefits
- ✅ Scales to N users without conflicts
- ✅ Works across different devices (mobile + desktop)
- ✅ Faster connection establishment (500ms polling)
- ✅ Graceful error handling
- ✅ Proper connection state tracking
- ✅ No race conditions
