from sqlalchemy import Column, String, Boolean, ForeignKey, DateTime, Integer, func, Numeric
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.database import Base


class Organizacion(Base):
    __tablename__ = "organizacion"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    nombre = Column(String(255), nullable=False)
    slug = Column(String(100), unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    usuarios = relationship("Usuario", back_populates="organizacion")
    sedes = relationship("Sede", back_populates="organizacion")
    snapshots = relationship("Snapshot", back_populates="organizacion")


class Usuario(Base):
    __tablename__ = "usuario"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    organizacion_id = Column(UUID(as_uuid=True), ForeignKey("organizacion.id", ondelete="CASCADE"), nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    rol = Column(String(50), nullable=False, default="admin")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    last_login = Column(DateTime(timezone=True))

    organizacion = relationship("Organizacion", back_populates="usuarios")


class Sede(Base):
    __tablename__ = "sede"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    organizacion_id = Column(UUID(as_uuid=True), ForeignKey("organizacion.id", ondelete="CASCADE"), nullable=False)
    nombre = Column(String(255), nullable=False)
    latitud = Column(Numeric(10, 7), nullable=False, default=-33.0360)
    longitud = Column(Numeric(10, 7), nullable=False, default=-71.4860)
    zoom_defecto = Column(Integer, nullable=False, default=17)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    organizacion = relationship("Organizacion", back_populates="sedes")
    snapshots = relationship("Snapshot", back_populates="sede")
    edificios = relationship("Edificio", back_populates="sede")


class Snapshot(Base):
    __tablename__ = "snapshot"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    sede_id = Column(UUID(as_uuid=True), ForeignKey("sede.id", ondelete="CASCADE"), nullable=False)
    organizacion_id = Column(UUID(as_uuid=True), ForeignKey("organizacion.id", ondelete="CASCADE"), nullable=False)
    payload = Column(JSONB, nullable=False)
    version = Column(Integer, nullable=False, default=1)
    published_at = Column(DateTime(timezone=True), server_default=func.now())

    sede = relationship("Sede", back_populates="snapshots")
    organizacion = relationship("Organizacion", back_populates="snapshots")


class Edificio(Base):
    __tablename__ = "edificio"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    sede_id = Column(UUID(as_uuid=True), ForeignKey("sede.id", ondelete="CASCADE"), nullable=False)
    organizacion_id = Column(UUID(as_uuid=True), ForeignKey("organizacion.id", ondelete="CASCADE"), nullable=False)
    nombre = Column(String(255), nullable=False)
    piso_min = Column(Integer, nullable=False, default=1)
    piso_max = Column(Integer, nullable=False, default=1)

    sede = relationship("Sede", back_populates="edificios")


class Sala(Base):
    __tablename__ = "sala"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    edificio_id = Column(UUID(as_uuid=True), ForeignKey("edificio.id", ondelete="CASCADE"), nullable=False)
    organizacion_id = Column(UUID(as_uuid=True), ForeignKey("organizacion.id", ondelete="CASCADE"), nullable=False)
    piso = Column(Integer, nullable=False)
    nombre = Column(String(255), nullable=False)


class Caracteristica(Base):
    __tablename__ = "caracteristica"

    id = Column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    codigo = Column(String(100), unique=True, nullable=False)
    nombre = Column(String(255), nullable=False)
    color_hex = Column(String(7), nullable=False)
