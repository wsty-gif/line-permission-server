const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: "wsty-39f48",
    clientEmail: "firebase-adminsdk-fbsvc@wsty-39f48.iam.gserviceaccount.com",
    privateKey: `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC+SY/+IdNLWav5\nTbKPkKexdYGu9FuU2oyk7BGnMwn84jI8+YgAO+fQxnDUYdXIyaaDvgmBfXwBtwXm\nF6l8S4fJfVrLuJ/0uDtryyDFYLrwv7iyEjRVwuuXiU8MILx0thWOrGVsmWFW8xF9\nsJ4hIAAg+uA0H/b+H4cqxkjdKqpKmzblJ/Hhob9qsKP53BT34O7Y1yHm9cgHJzTW\nCbs6OwdO46P0LCedjbuRuyyEuwFdw46AG2U16jyoTW5WaJ2z/cIgcMG+ydfx2yJv\nF3ggdsD8b8vu8e+9VlbqhXrGmYNh+xgcHH9/57ACrH6I1dK4lL7fvlOITkewK8AZ\ngOa+O9QJAgMBAAECggEAMIm5Jhzgtc641E3iZ0aBz/1mSAdiuPSKfaMN2bVmLdBQ\n+ka4Tz74ocOMklAmZSIyzFYUPKiSkilqYsfUXrUxfM7x8xc0DgtUdOmKgW5sIO72\noM2N9fZTfAL1W+WZzLeJhiwpbuss7i3wXzxHCbIM9lyoBgPFUAsgwmNzwJ6ac471\nQHGMU7qr2RvETn4LkP9eGHZkQSlsHukvaGlshaFUwtXWxnLcVB3LFzOR56kzg8yG\n6VKpNBUzIyJqWmC6mSqntBoch2ee0Nl5ryD0zP+H+6Qthdqw/9VN0l/j1XaPS74E\nVZp4GyIo/6XdOBAi6NrPm/C4wc0IFC2TYA4VZDnhBQKBgQDqxvecVh2j17B02DqV\nsg7wm64JsTYrk/NGI8ZGviJVHgKevduV26uhVTZNuAI/xAmZt5VWiftCuZLxOYxe\npbXQhtM4qyOc5bgBDO4CFaeEy/3ojxJ5GadQKlKsZ/2cCmwkmtFk27qdqMqsoZQg\naBTgophdHHuycBfvQpaKhILmFwKBgQDPfQuVrLtKJY8pibKd9fmzQ+/jAGKPeWKK\n5x0kGh8PgqkZumquxvsXY1wiVG44tfrIotPnhK2dJDIU5+OJOM2uROr3qi5lrHe+\n+7vYqdpiQa+J8RMaiNGYRFhiBPTNv4TIHJfYgd6ClqocTHWz1KVpC+jVsAxwsXNN\nykJgeluK3wKBgQDME42SmIyFKeyZdIdgLfmsjjZ2+FJ1CNLzSg+E2KsxP7fZUoE4\nP01uHIrqfaN+2CHcO2cVZTVCJ9sh0ftBHlvvWfLqlGCNdmU+jIWqzDXkSgl4iDzv\nhSwZk+BvOqmJZMnh+60+NX1+pAUgkAcZMD/Nj6hPb33aenNjp4cB+vNpmwKBgBRR\nuJq1ybmfJ//3Xiid+BAYLRvb48sNJhtYOsBYVoZcU1cTrHLlRZ2qu1EZV5nyKFcR\nqxLXKXFkJAtsEhpUF8BjO2d5oQWP+EIZwPGc4KgSqrAljathjrUMrGMc/SRRBx3Z\nvv0S6sl7G7mdu0EbJ/+7jNewX+eBWTta/VkZYnGdAoGBALorAJBbux9VHJoBq2dl\nY7NAA30OMN6daIrBK1OjgW3uCnY9cMy4DDR72wgbN/J/F6eNy7onL7YL7VIdD0il\nZssxgoaq61Ih/11eeSFYktNMo8CnzSbG3YONgdV503HOV6xp1zCiGovdP7CwqjWr\nkozeza89daieRyp/ZvdEjk1u\n-----END PRIVATE KEY-----\n`
  }),
});

admin.firestore().collection("test").add({ ok: true })
  .then(() => console.log("✅ Firestore OK"))
  .catch(console.error);
