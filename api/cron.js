const { ObjectId } = require("mongodb");
const clientPromise = require("../lib/mongodb");

const USER_ID = new ObjectId("68fcdf87385c4786896cf1f9");
const TIME_ZONE = "Asia/Kolkata";

function getIndiaDateTime() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

function getRandomCheckIn() {
  const start = 8 * 60 + 20; // 08:20
  const end = 9 * 60 + 20;   // 09:20

  const randomMinutes =
    Math.floor(Math.random() * (end - start + 1)) + start;

  const hour = Math.floor(randomMinutes / 60);
  const minutes = randomMinutes % 60;

  const hour12 = hour % 12 || 12;
  const ampm = hour >= 12 ? "PM" : "AM";

  return `${String(hour12).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )} ${ampm}`;
}

function calculateDuration(checkIn) {
  // checkIn format: "08:35 AM"
  const match = checkIn.match(/^(\d{2}):(\d{2}) (AM|PM)$/);

  if (!match) {
    throw new Error(`Invalid checkIn format: ${checkIn}`);
  }

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3];

  if (period === "PM" && hour !== 12) {
    hour += 12;
  }

  if (period === "AM" && hour === 12) {
    hour = 0;
  }

  const checkInMinutes = hour * 60 + minute;

  // 11:59 PM
  const checkOutMinutes = 23 * 60 + 59;

  return checkOutMinutes - checkInMinutes;
}

async function createCheckIn(db, date) {
  const checkIn = getRandomCheckIn();

  const result = await db.collection("attendances").insertOne({
    userId: USER_ID,
    date,
    checkIn,
    isLate: false,
  });

  return {
    action: "check-in",
    insertedId: result.insertedId,
    date,
    checkIn,
  };
}

async function createCheckOut(db, date) {
  /*
   * Find and update in ONE MongoDB operation.
   *
   * $exists:false means the document does not have a checkOut field.
   */
  const result = await db.collection("attendances").findOneAndUpdate(
    {
      userId: USER_ID,
      checkOut: { $exists: false },
    },
    {
      $set: {
        checkOutDate: date,
        checkOut: "11:59 PM",
      },
    },
    {
      sort: {
        date: -1,
      },
      returnDocument: "after",
    }
  );

  if (!result) {
    return {
      action: "check-out",
      updated: false,
      message: "No open attendance record found",
    };
  }

  const durationInMinutes = calculateDuration(result.checkIn);

  /*
   * Add duration separately because it depends on the existing checkIn.
   * We target the exact document by _id.
   */
  await db.collection("attendances").updateOne(
    { _id: result._id },
    {
      $set: {
        durationInMinutes,
      },
    }
  );

  return {
    action: "check-out",
    updated: true,
    documentId: result._id,
    checkIn: result.checkIn,
    checkOut: "11:59 PM",
    durationInMinutes,
  };
}

module.exports = async function handler(req, res) {
  // Protect the endpoint.
  const authHeader = req.headers.authorization;

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const client = await clientPromise;
    const db = client.db(process.env.MONGODB_DATABASE);

    // Get IST date/time only once.
    const { date, hour } = getIndiaDateTime();

    // Night cron: 7 PM or later.
    if (hour >= 19) {
      const result = await createCheckOut(db, date);

      return res.status(200).json({
        success: true,
        ...result,
      });
    }

    // Morning cron.
    const result = await createCheckIn(db, date);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("MongoDB error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to process attendance",
    });
  }
};