const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const port = process.env.PORT || 3000;
const crypto = require("crypto");
const admin = require("firebase-admin");

const serviceAccount = require("./firebaseAdminKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function generateTrackingId() {
  const prefix = "PRCL"; // your brand prefix
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

  return `${prefix}-${date}-${random}`;
}

//  middleWare
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  // console.log("Headers in the Middleware", req.headers.authorization);
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ massage: "unauthorized access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("Decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    console.log("Token verify failed:", err);
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3lourmh.mongodb.net/?appName=Cluster0`;

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.3lourmh.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("smart_db");
    const usersCollection = db.collection("zap_users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    // middle admin before allowing admin activity
    // must be used after verifyFBToken middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden admin access" });
      }
      next();
    };

    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        details: status.split("_").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingsCollection.insertOne(log);
      return result;
    };

    //  users related apis
    app.get("/zap_users", verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};

      // if(searchText){
      //   query.displayName = {$regex: searchText , $options : 'i'}
      // }

      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(6);
      const result = await cursor.toArray();
      res.send(result);
    });

    // app.get("/zap_users/:id/role", async (req, res) => {});

    // app.get(
    //   "/zap_users/:email/role",
    //   verifyFBToken,
    //   verifyAdmin,
    //   async (req, res) => {
    //     const email = req.params.email;
    //     const query = { email };
    //     const user = await usersCollection.findOne(query);
    //     res.send({ role: user?.role || "user" });
    //   }
    // );

    // app.get("/zap_users/:email/role", verifyFBToken, async (req, res) => {
    app.get("/zap_users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    //  users related apis
    app.post("/zap_users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res.send({ massage: "User Exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    //  users related apis
    app.patch("/zap_users/:id", async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.patch(
      "/zap_users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await usersCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    //  parcel api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      //  parcels?email=""&
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      // if (deliveryStatus) {
      //   query.deliveryStatus = { $in: ["driver_assigned", "rider_arriving"] };
      // }
      //
      // if (deliveryStatus) {
      //   query.deliveryStatus = { $nin: ["parcel_delivered"] };
      // }
      if (deliveryStatus !== "parcel_delivered") {
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }
      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;

      // generate tracking id
      const trackingId = generateTrackingId();

      // parcel created time
      // set created time and tracking id
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;

      // logTracking(trackingId, "parcel_created");
      logTracking(trackingId, "parcel_created");
      const result = await parcelsCollection.insertOne(parcel);
      res.send({
        success: true,
        trackingId,
        inserted: result,
      });
    });

    // TODO : rename this to be specific like /parcels/:id/assign
    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updatedDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelsCollection.updateOne(query, updatedDoc);
      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdatedDoc
      );
      // log tracking
      logTracking(trackingId, "driver_assigned");
      res.send(riderResult);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if (deliveryStatus === "parcel_delivered") {
        // update rider information
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdatedDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdatedDoc
        );
      }
      const result = await parcelsCollection.updateOne(query, updatedDoc);
      // log tracking
      logTracking(trackingId, deliveryStatus);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // payment related APIs ( new > 63-6)
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Please pay for : ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          trackingId: paymentInfo.trackingId,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled?`,
      });
      res.send({ url: session.url });
    });

    // payment related APIs( old 63-5 )
    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: paymentInfo.senderEmail,
    //     mode: "payment",
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //       parcelName: paymentInfo.parcelName,
    //     },
    //     // success_url: `${process.env.SITE_DOMAIN}?success=true`,
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);
      console.log(paymentExist);

      if (paymentExist) {
        return res.send({
          massage: "Already Exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      console.log("Session id", sessionId);
      console.log("Session retrieve", session);

      // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
      const trackingId = session.metadata.trackingId;

      // FIX: trackingId variable
      // const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            // trackingId: trackingId,
          },
        };

        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };
        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);
          logTracking(trackingId, "parcel_paid");
          // logTracking(trackingId, "parcel_paid");

          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            paymentInfo: resultPayment,
            transactionId: session.payment_intent,
          });
        }
      }

      return res.send({ success: false });
    });

    //  payment related apis
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      // console.log(" Headers ", req.headers);
      if (email) {
        query.customerEmail = email;

        //  check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // riders related apis
    app.get("/riders", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      // if (req.query.status) {
      //   query.status = req.query.status;
      // }
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // riders related apis
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // riders related apis
    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, updateDoc);
      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userUpdate = await usersCollection.updateOne(
          userQuery,
          updateUser
        );
      }
      res.send(result);
    });

    // tracking related apis
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingsCollection.find(query).toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap Shift Server is Running  !");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

// app.patch("/payment-success", async (req, res) => {
//   const sessionId = req.query.session_id;
//   const session = await stripe.checkout.sessions.retrieve(sessionId);
//   console.log("Session id", sessionId);
//   console.log("Session retrieve", session);
//   trackingId: generateTrackingId();

//   if (session.payment_status === "paid") {
//     const id = session.metadata.parcelId;
//     const query = { _id: new ObjectId(id) };
//     const update = {
//       $set: {
//         paymentStatus: "paid",
//         trackingId: trackingId,
//       },
//     };

//     const result = await parcelsCollection.updateOne(query, update);

//     const payment = {
//       amount: session.amount_total / 100,
//       currency: session.currency,
//       customerEmail: session.customer_email,
//       parcelId: session.metadata.parcelId,
//       parcelName: session.metadata.parcelName,
//       transactionId: session.payment_intent,
//       paymentStatus: session.payment_status,
//       paidAt: new Date(),
//     };

//     const resultPayment = await paymentCollection.insertOne(payment);

//     return res.send({
//       success: true,
//       modifyParcel: result,
//       trackingId: trackingId,
//       paymentInfo: resultPayment,
//       transactionId: session.payment_intent,
//     });
//   }

//   // if not paid
//   return res.send({ success: false });
// });

// app.patch("/payment-success", async (req, res) => {
//   const sessionId = req.query.session_id;
//   const session = await stripe.checkout.sessions.retrieve(sessionId);
//   console.log("Session id", sessionId);
//   console.log("Session retrieve", session);
//   if (session.payment_status === "paid") {
//     const id = session.metadata.parcelId;
//     const query = { _id: new ObjectId(id) };
//     const update = {
//       $set: {
//         paymentStatus: "paid",
//         trackingId : generateTrackingId()
//       },
//     };
//     const result = await parcelsCollection.updateOne(query, update);
//     const payment = {
//       amount: session.amount_total / 100,
//       currency: session.currency,
//       customerEmail: session.customer_email,
//       parcelId: session.metadata.parcelId,
//       parcelName: session.metadata.parcelName,
//       transactionId: session.payment_intent,
//       paymentStatus: session.payment_status,
//       paidAt : new Date(),
//     };
//     if (session.payment_status === "paid") {
//       const resultPayment = await paymentCollection.insertOne(payment)
//       res.send({ success: true, modifyParcel: result,paymentInfo:resultPayment
//     })
//     // res.send(result);
//   }
//   res.send({ success: false });
//   // res.send({ success: true });
// })
