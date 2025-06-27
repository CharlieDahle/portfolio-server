const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Simple room storage - just data, no playback logic
const rooms = new Map();

class DrumRoom {
  constructor(id) {
    this.id = id;
    this.bpm = 120;
    this.measureCount = 4; // Add measure count to room state
    this.pattern = new Map(); // trackId -> Set of tick positions
    this.tracks = new Map(); // trackId -> track data (name, color, soundFile, etc.)
    this.users = new Set();
    this.lastActivity = Date.now();

    // Initialize default tracks with empty patterns
    this.initializeDefaultTracks();
  }

  initializeDefaultTracks() {
    const defaultTracks = [
      {
        id: "kick",
        name: "Kick",
        color: "#e74c3c",
        soundFile: "kicks/Ac_K.wav",
        availableSounds: [],
      },
      {
        id: "snare",
        name: "Snare",
        color: "#f39c12",
        soundFile: "snares/Box_Snr2.wav",
        availableSounds: [],
      },
      {
        id: "hihat",
        name: "Hi-Hat",
        color: "#2ecc71",
        soundFile: "hihats/Jls_H.wav",
        availableSounds: [],
      },
      {
        id: "openhat",
        name: "Open Hat",
        color: "#3498db",
        soundFile: "cymbals/CL_OHH1.wav",
        availableSounds: [],
      },
    ];

    defaultTracks.forEach((track) => {
      this.tracks.set(track.id, track);
      this.pattern.set(track.id, new Set());
    });
  }

  addUser(userId) {
    this.users.add(userId);
    this.lastActivity = Date.now();
  }

  removeUser(userId) {
    this.users.delete(userId);
    this.lastActivity = Date.now();

    // Auto-cleanup empty rooms
    if (this.users.size === 0) {
      rooms.delete(this.id);
      console.log(`Room ${this.id} deleted - no users`);
    }
  }

  // Add a note at specific tick position
  addNote(trackId, tick) {
    if (!this.pattern.has(trackId)) {
      this.pattern.set(trackId, new Set());
    }
    this.pattern.get(trackId).add(tick);
    this.lastActivity = Date.now();
  }

  // Remove a note from specific tick position
  removeNote(trackId, tick) {
    if (this.pattern.has(trackId)) {
      this.pattern.get(trackId).delete(tick);
      this.lastActivity = Date.now();
    }
  }

  // Move a note from one position to another
  moveNote(trackId, fromTick, toTick) {
    if (this.pattern.has(trackId)) {
      const trackPattern = this.pattern.get(trackId);
      trackPattern.delete(fromTick);
      trackPattern.add(toTick);
      this.lastActivity = Date.now();
    }
  }

  // Clear entire track
  clearTrack(trackId) {
    if (this.pattern.has(trackId)) {
      this.pattern.get(trackId).clear();
      this.lastActivity = Date.now();
    }
  }

  // Get current room state for sending to clients
  getState() {
    // Convert Sets to Arrays for JSON serialization
    const serializedPattern = {};
    for (const [trackId, tickSet] of this.pattern.entries()) {
      serializedPattern[trackId] = Array.from(tickSet);
    }

    // Convert tracks Map to Array
    const serializedTracks = Array.from(this.tracks.values());

    return {
      id: this.id,
      bpm: this.bpm,
      measureCount: this.measureCount, // Include measure count in state
      pattern: serializedPattern,
      tracks: serializedTracks, // Include tracks in state
      users: Array.from(this.users),
    };
  }

  setBpm(newBpm) {
    this.bpm = Math.max(60, Math.min(300, newBpm)); // Clamp between 60-300
    this.lastActivity = Date.now();
  }

  // Add measure count management
  setMeasureCount(newMeasureCount) {
    this.measureCount = Math.max(1, Math.min(16, newMeasureCount)); // Clamp between 1-16
    this.lastActivity = Date.now();
  }

  // Track management
  addTrack(trackData) {
    this.tracks.set(trackData.id, trackData);
    this.pattern.set(trackData.id, new Set());
    this.lastActivity = Date.now();
  }

  removeTrack(trackId) {
    this.tracks.delete(trackId);
    this.pattern.delete(trackId);
    this.lastActivity = Date.now();
  }

  updateTrackSound(trackId, newSoundFile) {
    if (this.tracks.has(trackId)) {
      const track = this.tracks.get(trackId);
      track.soundFile = newSoundFile;
      this.tracks.set(trackId, track);
      this.lastActivity = Date.now();
    }
  }
}

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] User connected: ${socket.id}`);

  socket.on("ping", () => {
    console.log(`[${new Date().toISOString()}] Ping from ${socket.id}`);
  });

  socket.on("pong", (latency) => {
    console.log(
      `[${new Date().toISOString()}] Pong from ${
        socket.id
      }, latency: ${latency}ms`
    );
  });

  // Create new room
  socket.on("create-room", (callback) => {
    const roomId = uuidv4().slice(0, 8);
    const room = new DrumRoom(roomId);
    rooms.set(roomId, room);

    socket.join(roomId);
    room.addUser(socket.id);

    console.log(`Room created: ${roomId} by ${socket.id}`);

    callback({
      success: true,
      roomId,
      roomState: room.getState(),
    });
  });

  // Join existing room
  socket.on("join-room", ({ roomId }, callback) => {
    const room = rooms.get(roomId);

    if (!room) {
      callback({ success: false, error: "Room not found" });
      return;
    }

    socket.join(roomId);
    room.addUser(socket.id);

    console.log(`User ${socket.id} joined room ${roomId}`);

    // Send current room state to joining user
    callback({
      success: true,
      roomState: room.getState(),
    });

    // Notify other users in room
    socket.to(roomId).emit("user-joined", {
      userId: socket.id,
      userCount: room.users.size,
    });
  });

  // Handle pattern changes
  socket.on("pattern-change", ({ roomId, change }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid pattern change request:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(`Pattern change in room ${roomId}:`, change);

    // Apply the change to room state
    switch (change.type) {
      case "add-note":
        room.addNote(change.trackId, change.tick);
        break;

      case "remove-note":
        room.removeNote(change.trackId, change.tick);
        break;

      case "move-note":
        room.moveNote(change.trackId, change.fromTick, change.toTick);
        break;

      case "clear-track":
        room.clearTrack(change.trackId);
        break;

      default:
        console.log(`Unknown pattern change type: ${change.type}`);
        return;
    }

    // Broadcast change to all users in room (including sender for confirmation)
    socket.to(roomId).emit("pattern-update", change);
  });

  // Handle transport commands (play/pause/stop)
  socket.on("transport-command", ({ roomId, command }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid transport command:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Transport command in room ${roomId}:`, command);

    // Add high-precision timestamp for sync
    const syncCommand = {
      ...command,
      timestamp: Date.now(),
    };

    // Broadcast to all users in room with timestamp
    socket.to(roomId).emit("transport-sync", syncCommand);
  });

  // Handle BPM changes
  socket.on("set-bpm", ({ roomId, bpm }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid BPM change:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`BPM change in room ${roomId}: ${room.bpm} -> ${bpm}`);

    room.setBpm(bpm);

    // Broadcast BPM change to all users
    socket.to(roomId).emit("bpm-change", {
      bpm: room.bpm,
      timestamp: Date.now(),
    });
  });

  // Handle measure count changes
  socket.on("set-measure-count", ({ roomId, measureCount }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid measure count change:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(
      `Measure count change in room ${roomId}: ${room.measureCount} -> ${measureCount}`
    );

    room.setMeasureCount(measureCount);

    // Broadcast measure count change to all users
    socket.to(roomId).emit("measure-count-change", {
      measureCount: room.measureCount,
      timestamp: Date.now(),
    });
  });

  // Handle track addition
  socket.on("add-track", ({ roomId, trackData }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid add track request:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Track added in room ${roomId}:`, trackData);

    room.addTrack(trackData);

    // Broadcast track addition to all users (excluding sender)
    socket.to(roomId).emit("track-added", {
      trackData,
      timestamp: Date.now(),
    });
  });

  // Handle track removal
  socket.on("remove-track", ({ roomId, trackId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid remove track request:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(`Track removed in room ${roomId}:`, trackId);

    room.removeTrack(trackId);

    // Broadcast track removal to all users (excluding sender)
    socket.to(roomId).emit("track-removed", {
      trackId,
      timestamp: Date.now(),
    });
  });

  // Handle track sound changes
  socket.on("update-track-sound", ({ roomId, trackId, soundFile }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid track sound update:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Track sound updated in room ${roomId}:`, {
      trackId,
      soundFile,
    });

    room.updateTrackSound(trackId, soundFile);

    // Broadcast sound change to all users (excluding sender)
    socket.to(roomId).emit("track-sound-updated", {
      trackId,
      soundFile,
      timestamp: Date.now(),
    });
  });

  // Handle track addition
  socket.on("add-track", ({ roomId, trackData }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid add track request:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Track added in room ${roomId}:`, trackData);

    room.addTrack(trackData);

    // Broadcast track addition to all users
    socket.to(roomId).emit("track-added", {
      trackData,
      timestamp: Date.now(),
    });
  });

  // Handle track removal
  socket.on("remove-track", ({ roomId, trackId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid remove track request:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(`Track removed in room ${roomId}:`, trackId);

    room.removeTrack(trackId);

    // Broadcast track removal to all users
    socket.to(roomId).emit("track-removed", {
      trackId,
      timestamp: Date.now(),
    });
  });

  // Handle track sound changes
  socket.on("update-track-sound", ({ roomId, trackId, soundFile }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid track sound update:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Track sound updated in room ${roomId}:`, {
      trackId,
      soundFile,
    });

    room.updateTrackSound(trackId, soundFile);

    // Broadcast sound change to all users
    socket.to(roomId).emit("track-sound-updated", {
      trackId,
      soundFile,
      timestamp: Date.now(),
    });
  });

  // Get current room state (for periodic sync if needed)
  socket.on("get-room-state", ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (room && room.users.has(socket.id)) {
      callback({ success: true, roomState: room.getState() });
    } else {
      callback({ success: false, error: "Room not found or not a member" });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(
      `[${new Date().toISOString()}] User disconnected: ${socket.id}`
    );

    // Remove user from all rooms they were in
    rooms.forEach((room, roomId) => {
      if (room.users.has(socket.id)) {
        room.removeUser(socket.id);

        // Notify remaining users
        socket.to(roomId).emit("user-left", {
          userId: socket.id,
          userCount: room.users.size,
        });
      }
    });
  });

  socket.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Socket error:`, err.message);
  });
});

// Cleanup old empty rooms periodically
setInterval(() => {
  const now = Date.now();
  const ROOM_TIMEOUT = 1000 * 60 * 60; // 1 hour

  rooms.forEach((room, roomId) => {
    if (room.users.size === 0 && now - room.lastActivity > ROOM_TIMEOUT) {
      rooms.delete(roomId);
      console.log(`Cleaned up old room: ${roomId}`);
    }
  });
}, 1000 * 60 * 15); // Check every 15 minutes

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Simplified drum server running on port ${PORT}`);
  console.log(`Server architecture: Pattern storage + Command broadcasting`);
});
